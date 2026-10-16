import { AnimatePresence, motion } from 'framer-motion'
import { Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import {
  DEFAULT_VAULT_ID,
  type IdentityMeta,
  type SecretMeta,
  type SshKeyMeta,
  type VaultMeta,
} from '../../../../shared/vault'
import { api } from '../../lib/api'
import { Badge } from '../../ui/Badge'
import { registerCommand } from '../../ui/commands'
import { fast, spring, useMotionSafe } from '../../ui/motion'
import { Padlock } from '../../ui/Padlock'
import { useShortcut } from '../../ui/shortcuts'
import { Skeleton } from '../../ui/Skeleton'
import { toast } from '../../ui/Toaster'
import { useVaultStatus } from '../../vault/status'
import { ConfirmDialog, fail, type ConfirmRequest } from '../../ui/common'
import { IdentitiesPanel } from './IdentitiesPanel'
import { IdentityDialog } from './IdentityDialog'
import { GenerateKeyDialog, ImportKeyDialog, LinkKeyDialog } from './KeyDialogs'
import { KeysPanel } from './KeysPanel'
import { SecretDialog } from './SecretDialog'
import { hideAllReveals, SecretsPanel } from './SecretsPanel'
import { VaultDialog, VaultRail } from './VaultRail'
import { CorruptVault, Empty, SkeletonRows, TABS, Toolbar, type NewDialog, type Tab } from './VaultsParts'

interface VaultData {
  vaultId: string
  secrets: SecretMeta[]
  keys: SshKeyMeta[]
  identities: IdentityMeta[]
}

const isTab = (t: string | null): t is Tab => TABS.some((x) => x.id === t)
const upsert = <T extends { id: string }>(list: T[], item: T) =>
  list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item]

export function VaultsPage() {
  const motionSafe = useMotionSafe()
  const status = useVaultStatus()
  const corruptIds = useMemo(() => status?.corruptVaultIds ?? [], [status])
  const [params, setParams] = useSearchParams()
  const tab: Tab = isTab(params.get('tab')) ? (params.get('tab') as Tab) : 'secrets'

  const [vaults, setVaults] = useState<VaultMeta[] | null>(null)
  const [data, setData] = useState<VaultData | null>(null)
  // Rows cascade in once per fresh load, not on every tab switch.
  const [fresh, setFresh] = useState(true)
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<NewDialog | null>(null)
  const [vaultDialog, setVaultDialog] = useState<{ open: boolean; vault?: VaultMeta }>({ open: false })
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)

  const wanted = params.get('vault') ?? DEFAULT_VAULT_ID
  const vaultId = vaults && !vaults.some((v) => v.id === wanted) ? DEFAULT_VAULT_ID : wanted
  const vault = vaults?.find((v) => v.id === vaultId)
  const corrupt = corruptIds.includes(vaultId)

  const go = useCallback(
    (next: { vault?: string; tab?: Tab }) => {
      setParams(
        (p) => {
          const out = new URLSearchParams(p)
          if (next.vault) out.set('vault', next.vault)
          if (next.tab) out.set('tab', next.tab)
          return out
        },
        { replace: true },
      )
    },
    [setParams],
  )

  useEffect(() => {
    let live = true
    api
      .invoke('vault:list')
      .then((v) => live && setVaults(v))
      .catch((err: unknown) => {
        if (!live) return
        setVaults([])
        fail("Couldn't load vaults", err)
      })
    return () => {
      live = false
    }
  }, [])

  // Lists are metadata only and load without an unlock; a corrupt vault has nothing to show.
  const vaultsLoaded = vaults !== null
  useEffect(() => {
    if (!vaultsLoaded || corrupt) return
    let live = true
    setFresh(true)
    Promise.all([
      api.invoke('secret:list', vaultId),
      api.invoke('key:list', vaultId),
      api.invoke('identity:list', vaultId),
    ])
      .then(([secrets, keys, identities]) => live && setData({ vaultId, secrets, keys, identities }))
      .catch((err: unknown) => {
        if (!live) return
        setData({ vaultId, secrets: [], keys: [], identities: [] })
        fail("Couldn't load this vault", err)
      })
    return () => {
      live = false
    }
    // Reloads when the vault changes, not when the vault list does.
  }, [vaultId, vaultsLoaded, corrupt])

  useEffect(() => setQuery(''), [vaultId, tab])

  const current = data?.vaultId === vaultId ? data : null
  const patch = (fn: (d: VaultData) => VaultData) => setData((d) => (d && d.vaultId === vaultId ? fn(d) : d))

  // Counts in the rail follow what this page has loaded for the open vault.
  const railVaults = useMemo(
    () =>
      vaults?.map((v) =>
        current && v.id === current.vaultId
          ? {
              ...v,
              counts: { secrets: current.secrets.length, keys: current.keys.length, identities: current.identities.length },
            }
          : v,
      ) ?? null,
    [vaults, current],
  )

  const openNew = useCallback(
    (which: NewDialog) => {
      if (corrupt) {
        toast({ title: "This vault can't be opened", tone: 'error' })
        return
      }
      const forTab: Tab = which === 'secret' ? 'secrets' : which === 'identity' ? 'identities' : 'keys'
      go({ tab: forTab })
      setDialog(which)
    },
    [corrupt, go],
  )

  const openNewRef = useRef(openNew)
  useEffect(() => {
    openNewRef.current = openNew
  })
  useEffect(() => {
    const off = [
      registerCommand({
        id: 'vaults.newSecret',
        title: 'New secret',
        section: 'Vaults',
        keywords: ['password', 'token', 'env'],
        run: () => openNewRef.current('secret'),
      }),
      registerCommand({
        id: 'vaults.generateKey',
        title: 'Generate SSH key',
        section: 'Vaults',
        keywords: ['ed25519', 'keypair'],
        run: () => openNewRef.current('generate'),
      }),
      registerCommand({
        id: 'vaults.newIdentity',
        title: 'New identity',
        section: 'Vaults',
        keywords: ['user', 'login'],
        run: () => openNewRef.current('identity'),
      }),
      registerCommand({
        id: 'vaults.newVault',
        title: 'New vault',
        section: 'Vaults',
        run: () => setVaultDialog({ open: true }),
      }),
    ]
    return () => off.forEach((fn) => fn())
  }, [])

  // Revealed values don't wait out their timer once the page is gone.
  useEffect(() => hideAllReveals, [])

  useShortcut('mod+n', () => openNew(tab === 'secrets' ? 'secret' : tab === 'keys' ? 'generate' : 'identity'))

  const q = query.trim().toLowerCase()
  const shown = current && {
    secrets: current.secrets.filter((s) => s.name.toLowerCase().includes(q)),
    keys: current.keys.filter((k) => k.label.toLowerCase().includes(q)),
    identities: current.identities.filter(
      (i) => i.label.toLowerCase().includes(q) || i.username.toLowerCase().includes(q),
    ),
  }
  const total = current ? current[tab].length : 0
  const tabInfo = TABS.find((t) => t.id === tab)!
  const panelId = 'vaults-tabpanel'

  return (
    <div className="flex h-full">
      <VaultRail
        vaults={railVaults}
        currentId={vaultId}
        corruptIds={corruptIds}
        onSelect={(id) => go({ vault: id })}
        onNew={() => setVaultDialog({ open: true })}
        onRename={(v) => setVaultDialog({ open: true, vault: v })}
        onChanged={(v) => setVaults((list) => list && upsert(list, v))}
        onDeleted={(id) => {
          setVaults((list) => list && list.filter((v) => v.id !== id))
          if (id === vaultId) go({ vault: DEFAULT_VAULT_ID })
        }}
        confirm={setConfirm}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="app-drag flex h-16 shrink-0 items-end justify-between gap-4 px-8 pb-3">
          <div className="flex min-w-0 items-center gap-3">
            {vault ? (
              <AnimatePresence initial={false} mode="popLayout">
                <motion.div
                  key={vault.id}
                  initial={motionSafe ? { opacity: 0, y: 4 } : { opacity: 0 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={motionSafe ? spring : fast}
                  className="flex min-w-0 items-center gap-3"
                >
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ background: vault.color, boxShadow: `0 0 12px ${vault.color}` }}
                  />
                  <h2 className="truncate text-[19px] font-semibold tracking-tight text-fg">{vault.name}</h2>
                  {corrupt ? (
                    <Badge tone="error" dot>
                      Can't be opened
                    </Badge>
                  ) : (
                    <Badge tone="success">
                      <Padlock open className="size-3" />
                      Unlocked
                    </Badge>
                  )}
                </motion.div>
              </AnimatePresence>
            ) : (
              <Skeleton className="h-6 w-40" />
            )}
          </div>
          {!corrupt && (
            <label className="relative flex h-8 w-[240px] items-center">
              <Search aria-hidden className="pointer-events-none absolute left-2.5 size-3.5 text-muted" />
              <input
                type="search"
                aria-label={`Search ${tabInfo.noun}`}
                placeholder={`Search ${tabInfo.noun}…`}
                spellCheck={false}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-8 w-full rounded-lg border border-line bg-surface-2/60 pr-2.5 pl-8 text-[12.5px] text-fg transition-colors placeholder:text-muted/70 hover:border-muted/30 focus:border-accent/60 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery('')}
                  className="absolute right-1.5 grid size-5 place-items-center rounded text-muted hover:text-fg"
                >
                  <X aria-hidden className="size-3" />
                </button>
              )}
            </label>
          )}
        </header>

        {corrupt ? (
          <CorruptVault />
        ) : (
          <>
            <div className="flex items-end justify-between gap-4 border-b border-line px-8">
              <div role="tablist" aria-label="Vault contents" className="flex gap-1">
                {TABS.map((t) => {
                  const selected = t.id === tab
                  return (
                    <button
                      key={t.id}
                      type="button"
                      role="tab"
                      id={`vaults-tab-${t.id}`}
                      aria-selected={selected}
                      aria-controls={panelId}
                      onClick={() => {
                        setFresh(false)
                        go({ tab: t.id })
                      }}
                      className={`relative flex h-10 items-center gap-2 px-3 text-[13px] font-medium transition-colors ${
                        selected ? 'text-fg' : 'text-muted hover:text-fg/90'
                      }`}
                    >
                      {t.label}
                      <span
                        className={`min-w-5 rounded-full px-1.5 text-center text-[11px] leading-[18px] tabular-nums ${
                          selected ? 'bg-accent/15 text-accent' : 'bg-white/[0.05] text-muted'
                        }`}
                      >
                        {current ? current[t.id].length : '–'}
                      </span>
                      {selected && (
                        <motion.span
                          layoutId={motionSafe ? 'vaults-tab-underline' : undefined}
                          transition={spring}
                          aria-hidden
                          className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-accent"
                        />
                      )}
                    </button>
                  )
                })}
              </div>
              <Toolbar tab={tab} onNew={openNew} />
            </div>

            <div
              role="tabpanel"
              id={panelId}
              aria-labelledby={`vaults-tab-${tab}`}
              className="min-h-0 flex-1 overflow-y-auto px-8 pt-4 pb-8"
            >
              {!current || !shown ? (
                <SkeletonRows />
              ) : total === 0 ? (
                <Empty tab={tab} onNew={openNew} />
              ) : shown[tab].length === 0 ? (
                <p className="py-16 text-center text-[13px] text-muted">No {tabInfo.noun} match “{query.trim()}”.</p>
              ) : (
                <div className="overflow-hidden rounded-ui border border-line bg-surface/50">
                  {tab === 'secrets' && (
                    <SecretsPanel
                      secrets={shown.secrets}
                      stagger={fresh}
                      onChanged={(s) => patch((d) => ({ ...d, secrets: upsert(d.secrets, s) }))}
                      onDeleted={(id) => patch((d) => ({ ...d, secrets: d.secrets.filter((s) => s.id !== id) }))}
                      confirm={setConfirm}
                    />
                  )}
                  {tab === 'keys' && (
                    <KeysPanel
                      keys={shown.keys}
                      stagger={fresh}
                      onChanged={(k) => patch((d) => ({ ...d, keys: upsert(d.keys, k) }))}
                      onDeleted={(id) => patch((d) => ({ ...d, keys: d.keys.filter((k) => k.id !== id) }))}
                      confirm={setConfirm}
                    />
                  )}
                  {tab === 'identities' && (
                    <IdentitiesPanel
                      identities={shown.identities}
                      keys={current.keys}
                      stagger={fresh}
                      onChanged={(i) => patch((d) => ({ ...d, identities: upsert(d.identities, i) }))}
                      onDeleted={(id) => patch((d) => ({ ...d, identities: d.identities.filter((i) => i.id !== id) }))}
                      confirm={setConfirm}
                    />
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </section>

      <SecretDialog
        open={dialog === 'secret'}
        vaultId={vaultId}
        onClose={() => setDialog(null)}
        onSaved={(s) => {
          setFresh(false)
          patch((d) => ({ ...d, secrets: upsert(d.secrets, s) }))
          setDialog(null)
        }}
      />
      {(['generate', 'import', 'link'] as const).map((which) => {
        const Dlg = which === 'generate' ? GenerateKeyDialog : which === 'import' ? ImportKeyDialog : LinkKeyDialog
        return (
          <Dlg
            key={which}
            open={dialog === which}
            vaultId={vaultId}
            onClose={() => setDialog(null)}
            onSaved={(k) => {
              setFresh(false)
              patch((d) => ({ ...d, keys: upsert(d.keys, k) }))
              setDialog(null)
            }}
          />
        )
      })}
      <IdentityDialog
        open={dialog === 'identity'}
        vaultId={vaultId}
        keys={current?.keys ?? []}
        onClose={() => setDialog(null)}
        onSaved={(i) => {
          setFresh(false)
          patch((d) => ({ ...d, identities: upsert(d.identities, i) }))
          setDialog(null)
        }}
      />
      <VaultDialog
        open={vaultDialog.open}
        vault={vaultDialog.vault}
        onClose={() => setVaultDialog((s) => ({ ...s, open: false }))}
        onSaved={(v, created) => {
          setVaults((list) => list && upsert(list, v))
          setVaultDialog((s) => ({ ...s, open: false }))
          if (created) go({ vault: v.id, tab: 'secrets' })
        }}
      />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}
