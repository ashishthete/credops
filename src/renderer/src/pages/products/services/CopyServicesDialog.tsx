import { motion } from 'framer-motion'
import { useId, useMemo, useRef, useState } from 'react'
import { GIT_REF, REPO_PATH } from '../../../../../shared/deploy'
import type { EnvironmentMeta, HostMeta, RegionMeta } from '../../../../../shared/inventory'
import { deriveTag, envAppHost, type CopyServicesRequest, type CopyServicesResult, type DbServiceMeta } from '../../../../../shared/services'
import { deployStore, loadDeploy, useDeployments, useServices } from '../../../deploy/store'
import { hostsByRegion, regionHintText } from '../../../inventory/regions'
import { reloadInventory, useInventory } from '../../../inventory/store'
import { api } from '../../../lib/api'
import { Button } from '../../../ui/Button'
import { attempt, plural } from '../../../ui/common'
import { Dialog } from '../../../ui/Dialog'
import { SelectField, TextField } from '../../../ui/Field'
import { fast, spring, staggerDelay, useMotionSafe } from '../../../ui/motion'

const NOT_COPIED =
  'Vault links, secrets, URLs and tunnels are not copied. Managed .env templates are copied with secret values cleared and turned off.'

type CheckoutRow = { branch: string; repoPath: string; hostId: string; tag: string }
type DbRow = { dbAddress: string; dbPort: string; viaHostId: string }

/** Copies an environment's services and checkouts to another; the per-environment fields are asked for here. */
export function CopyServicesDialog({ source, onClose }: { source: EnvironmentMeta | null; onClose: () => void }) {
  // The last source, so the title and body stay while the dialog animates out.
  const last = useRef(source)
  if (source) last.current = source
  const shown = source ?? last.current
  return (
    <Dialog open={source !== null} onClose={onClose} width={640} title={`Copy services from ${shown?.name ?? ''}`} description="Checkouts and services go to another environment.">
      {shown && <CopyBody key={shown.id} source={shown} onClose={onClose} />}
    </Dialog>
  )
}

function CopyBody({ source, onClose }: { source: EnvironmentMeta; onClose: () => void }) {
  const formId = useId()
  const data = useInventory()
  const motionSafe = useMotionSafe()
  const checkouts = useDeployments(source.id)
  const dbs = useServices(source.id).filter((s): s is DbServiceMeta => s.kind === 'db')
  const [targetId, setTargetId] = useState('')
  const [rows, setRows] = useState<Record<string, CheckoutRow>>({})
  const [dbRows, setDbRows] = useState<Record<string, DbRow>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CopyServicesResult | null>(null)

  const environments = data?.environments.filter((e) => e.id !== source.id) ?? []
  const target = environments.find((e) => e.id === targetId)
  const hosts = useMemo(() => [...(data?.hosts ?? [])].sort((a, b) => a.label.localeCompare(b.label)), [data])
  const label = (id: string) => hosts.find((h) => h.id === id)?.label ?? ''
  const members = hosts.filter((h) => target?.hosts.some((m) => m.hostId === h.id))
  const others = hosts.filter((h) => !target?.hosts.some((m) => m.hostId === h.id))
  const appHostOf = (env: EnvironmentMeta) =>
    envAppHost(
      env.hosts,
      hosts,
      deployStore.get().deployments.filter((d) => d.environmentId === env.id).map((d) => d.hostId),
    )
  const appHost = target ? appHostOf(target) : null
  const regions = data?.regions ?? []
  // A host from outside the target joins it; say so when it brings a region the target doesn't use yet.
  const hintFor = (hostId: string) => {
    const h = hosts.find((x) => x.id === hostId)
    if (!data || !target || !h || target.hosts.some((m) => m.hostId === hostId)) return null
    const { deployments, services } = deployStore.get()
    return regionHintText(data, target.id, h, deployments, services)
  }
  // The tag follows the environment's name when it holds it; otherwise it is asked for.
  const derived = (tag: string) => (target ? deriveTag(tag, source.name, target.name) : null)

  const pick = (id: string) => {
    setTargetId(id)
    setError(null)
    const env = environments.find((e) => e.id === id)
    const host = env ? (appHostOf(env) ?? '') : ''
    setRows(Object.fromEntries(checkouts.map((d) => [d.id, { branch: d.defaultBranch, repoPath: d.repoPath, hostId: host, tag: '' }])))
    setDbRows(Object.fromEntries(dbs.map((s) => [s.id, { dbAddress: s.dbAddress, dbPort: String(s.dbPort), viaHostId: '' }])))
  }
  const setRow = (id: string, change: Partial<CheckoutRow>) => setRows((r) => ({ ...r, [id]: { ...r[id], ...change } }))
  const setDb = (id: string, change: Partial<DbRow>) => setDbRows((r) => ({ ...r, [id]: { ...r[id], ...change } }))

  const errors = {
    branch: (r: CheckoutRow) => (r.branch && !GIT_REF.test(r.branch) ? 'Use a valid branch name' : undefined),
    repoPath: (r: CheckoutRow) => (r.repoPath && !REPO_PATH.test(r.repoPath) ? 'Use an absolute path, with no ".." or "//"' : undefined),
    tag: (r: CheckoutRow) => (r.tag && !GIT_REF.test(r.tag) ? 'Use a valid tag name' : undefined),
    port: (r: DbRow) => (r.dbPort && !(/^\d+$/.test(r.dbPort) && +r.dbPort >= 1 && +r.dbPort <= 65535) ? 'A port is 1 to 65535' : undefined),
  }
  const empty = checkouts.length === 0 && dbs.length === 0
  const ready =
    !!target &&
    !empty &&
    checkouts.every((d) => {
      const r = rows[d.id]
      return r && GIT_REF.test(r.branch) && REPO_PATH.test(r.repoPath) && r.hostId && (derived(d.deployTag) !== null || GIT_REF.test(r.tag))
    }) &&
    dbs.every((s) => {
      const r = dbRows[s.id]
      return r && r.dbAddress.trim() && !errors.port(r) && r.dbPort
    })

  const submit = async () => {
    if (!ready || !target) return
    const req: CopyServicesRequest = {
      sourceEnvironmentId: source.id,
      targetEnvironmentId: target.id,
      checkouts: checkouts.map((d) => {
        const r = rows[d.id]
        return { deploymentId: d.id, branch: r.branch, repoPath: r.repoPath, hostId: r.hostId, deployTag: derived(d.deployTag) ?? r.tag }
      }),
      dbs: dbs.map((s) => {
        const r = dbRows[s.id]
        return { serviceId: s.id, dbAddress: r.dbAddress.trim(), dbPort: Number(r.dbPort), viaHostId: r.viaHostId || null }
      }),
    }
    setBusy(true)
    setError(null)
    const out = await attempt("Couldn't copy the services", () => api.invoke('service:copy', req), setError)
    setBusy(false)
    if (!out) return
    setResult(out)
    void loadDeploy([target.id])
    if (out.addedHosts > 0) void reloadInventory()
  }

  if (result && target) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[13px] font-medium text-fg">{`Copied ${plural(result.created.services, 'service')} and ${plural(result.created.checkouts, 'checkout')} to ${target.name}`}</p>
        {result.skipped.length > 0 && (
          <div className="flex flex-col gap-1">
            <h3 className="text-[12px] font-semibold text-muted">Skipped</h3>
            <ul aria-label="Skipped" className="flex flex-col gap-0.5 text-[12.5px] text-fg/85">
              {result.skipped.map((s) => (
                <li key={`${s.kind}:${s.name}`}>{`${s.name} (${s.kind}): ${s.reason}`}</li>
              ))}
            </ul>
          </div>
        )}
        {result.addedHosts > 0 && <p className="text-[12.5px] text-muted">{`Added ${plural(result.addedHosts, 'host')} to ${target.name} as app hosts`}</p>}
        <div className="flex justify-end pt-2">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    )
  }

  const hostOptions = (empty: string) => (
    <>
      <option value="">{empty}</option>
      <RegionGroups regions={regions} hosts={members} />
      <RegionGroups regions={regions} hosts={others} joins />
    </>
  )
  let index = 0
  const enter = () => ({
    initial: motionSafe ? { opacity: 0, y: 4 } : { opacity: 0 },
    animate: motionSafe ? { opacity: 1, y: 0 } : { opacity: 1 },
    transition: motionSafe ? { ...spring, delay: staggerDelay(index++) } : fast,
  })

  return (
    <form
      id={formId}
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="w-64">
        <SelectField label="Target environment" value={targetId} onChange={(e) => pick(e.target.value)}>
          <option value="">Pick an environment</option>
          {environments.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </SelectField>
      </div>

      {target && (
        <>
          {checkouts.map((d) => {
            const r = rows[d.id]
            if (!r) return null
            const tag = derived(d.deployTag)
            const hint = hintFor(r.hostId)
            return (
              <motion.fieldset key={d.id} aria-label={d.name} {...enter()} className="flex flex-col gap-2 rounded-xl border border-line p-3">
                <legend className="px-1 text-[12.5px] font-semibold text-fg">{d.name}</legend>
                <div className="grid grid-cols-3 gap-3">
                  <TextField label="Branch" value={r.branch} onChange={(e) => setRow(d.id, { branch: e.target.value })} error={errors.branch(r)} />
                  <TextField label="Path" value={r.repoPath} onChange={(e) => setRow(d.id, { repoPath: e.target.value })} error={errors.repoPath(r)} />
                  <SelectField label="Host" value={r.hostId} onChange={(e) => setRow(d.id, { hostId: e.target.value })}>
                    {hostOptions('Pick a host')}
                  </SelectField>
                </div>
                {hint && <p className="text-[12px] text-muted">{hint}</p>}
                {tag === null ? (
                  <div className="w-64">
                    <TextField
                      label="Tag"
                      value={r.tag}
                      onChange={(e) => setRow(d.id, { tag: e.target.value })}
                      error={errors.tag(r)}
                      hint={`${d.deployTag} doesn't name ${source.name}, so the tag for ${target.name} can't be derived`}
                    />
                  </div>
                ) : (
                  <p className="text-[12px] text-muted">
                    Tag <span className="font-mono text-fg/85">{tag}</span>
                  </p>
                )}
              </motion.fieldset>
            )
          })}
          {dbs.map((s) => {
            const r = dbRows[s.id]
            if (!r) return null
            return (
              <motion.fieldset key={s.id} aria-label={s.name} {...enter()} className="flex flex-col gap-2 rounded-xl border border-line p-3">
                <legend className="px-1 text-[12.5px] font-semibold text-fg">{s.name}</legend>
                <div className="grid grid-cols-3 gap-3">
                  <TextField label="Address" value={r.dbAddress} onChange={(e) => setDb(s.id, { dbAddress: e.target.value })} />
                  <TextField label="Port" inputMode="numeric" value={r.dbPort} onChange={(e) => setDb(s.id, { dbPort: e.target.value })} error={errors.port(r)} />
                  <SelectField label="Via host" value={r.viaHostId} onChange={(e) => setDb(s.id, { viaHostId: e.target.value })}>
                    <option value="">{appHost ? `App host (${label(appHost)})` : 'App host'}</option>
                    <RegionGroups regions={regions} hosts={members} />
                  </SelectField>
                </div>
              </motion.fieldset>
            )
          })}
          {empty ? (
            <p className="text-[12.5px] text-muted">{`${source.name} has no checkouts or databases to copy`}</p>
          ) : (
            <p className="text-[12px] text-muted">{NOT_COPIED}</p>
          )}
        </>
      )}

      {error && (
        <p role="alert" className="text-[12.5px] text-err">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} disabled={!ready}>
          Copy services
        </Button>
      </div>
    </form>
  )
}

/** One optgroup per region; `joins` marks hosts from outside the target, which join it as app hosts. */
function RegionGroups({ regions, hosts, joins = false }: { regions: readonly RegionMeta[]; hosts: HostMeta[]; joins?: boolean }) {
  return hostsByRegion(regions, hosts).map(({ region, hosts: group }) => {
    const code = region?.code ?? 'No region'
    return (
      <optgroup key={group[0]!.regionId} label={joins ? `Other hosts in ${code} (joins as an app host)` : code}>
        {group.map((h) => (
          <option key={h.id} value={h.id}>
            {h.label}
          </option>
        ))}
      </optgroup>
    )
  })
}
