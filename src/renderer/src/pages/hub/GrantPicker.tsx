import { useMemo, useState } from 'react'
import type { GrantScope, HubCatalogEnv } from '../../../../shared/hub'
import { useHub } from '../../hub/store'
import { useInventory } from '../../inventory/store'
import { Button } from '../../ui/Button'
import { byProduct } from './names'

const select = 'h-7 rounded-md border border-line bg-surface-2/60 px-2 text-[12.5px] text-fg'

/** Environments the picker can offer: every published one for an admin, else what the person's catalog shows. */
export function useGrantEnvs(): HubCatalogEnv[] {
  const { adminEnvs, catalog } = useHub()
  return adminEnvs.length ? adminEnvs : catalog
}

/** How a grant reads in a list: the environment and deployment by name when the Hub still knows them. */
export function grantLabel(scope: GrantScope, envs: HubCatalogEnv[]): string {
  if (scope.kind === 'all') return 'All environments'
  const env = envs.find((e) => e.environment.id === scope.environmentId)
  const envName = env?.environment.name ?? 'an unpublished environment'
  if (scope.kind === 'environment') return `Environment: ${envName}`
  const dep = env?.deployments.find((d) => d.id === scope.deploymentId)
  return `Deployment: ${dep?.name ?? 'unknown'} in ${envName}`
}

type Kind = GrantScope['kind']

/** All environments, one environment, or one deployment in one environment. */
export function GrantPicker({ groupName, onAdd }: { groupName: string; onAdd: (scope: GrantScope) => void | Promise<unknown> }) {
  const envs = useGrantEnvs()
  const [kind, setKind] = useState<Kind>('all')
  const [envId, setEnvId] = useState('')
  const [depId, setDepId] = useState('')
  const env = useMemo(() => envs.find((e) => e.environment.id === envId), [envs, envId])
  const data = useInventory()
  const { groups, rest } = useMemo(() => byProduct(envs, (e) => e.environment.id, data, (e) => e.environment.product?.name), [envs, data])
  const option = (e: HubCatalogEnv) => (
    <option key={e.environment.id} value={e.environment.id}>
      {e.environment.name}
    </option>
  )

  const scope: GrantScope | null =
    kind === 'all' ? { kind: 'all' } : kind === 'environment' ? (envId ? { kind, environmentId: envId } : null) : envId && depId ? { kind, environmentId: envId, deploymentId: depId } : null

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <select
        aria-label={`Grant scope for ${groupName}`}
        className={select}
        value={kind}
        onChange={(e) => {
          setKind(e.target.value as Kind)
          setDepId('')
        }}
      >
        <option value="all">All environments</option>
        <option value="environment">One environment</option>
        <option value="deployment">One deployment</option>
      </select>
      {kind !== 'all' && (
        <select
          aria-label={`Environment for ${groupName}`}
          className={select}
          value={envId}
          onChange={(e) => {
            setEnvId(e.target.value)
            setDepId('')
          }}
        >
          <option value="">Choose an environment…</option>
          {groups.map((g) => (
            <optgroup key={g.id} label={g.name}>
              {g.items.map(option)}
            </optgroup>
          ))}
          {rest.map(option)}
        </select>
      )}
      {kind === 'deployment' && (
        <select aria-label={`Deployment for ${groupName}`} className={select} value={depId} disabled={!env} onChange={(e) => setDepId(e.target.value)}>
          <option value="">Choose a deployment…</option>
          {env?.deployments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      )}
      <Button size="sm" variant="ghost" aria-label={`Add grant to ${groupName}`} disabled={!scope} onClick={() => scope && void onAdd(scope)}>
        Add grant
      </Button>
    </div>
  )
}
