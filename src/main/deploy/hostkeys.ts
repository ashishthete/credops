import type { Client } from 'ssh2'
import type { ResolvedHost } from '../../shared/inventory'
import { PREPARE_DIAL_TIMEOUT_MS, type PreflightCheck } from '../../shared/deploy'
import type { IdentityStore } from '../vault/identity-store'
import { AuthFailedError, describeError, hopsOf, type connectChain, type ConnectDeps, type HopTarget } from '../ssh/connect'
import { authPlan, type AuthDeps } from '../ssh/auth'
import { hostToken, type KnownHostStore } from '../ssh/known-hosts'
import { verifyWithStore, type PromptBroker } from '../ssh/prompts'
import type { DeployPlan } from './runner'

/* Before a release starts: dial every host chain with OpsDeck's own SSH stack so host keys are trusted and the
   keys ssh will need are known. Nothing here touches ~/.ssh/known_hosts or writes to ~/.ssh. */

export interface KnownHostEntry {
  token: string
  keyType: string
  keyBase64: string
}

export interface PreparedHosts {
  knownHosts: KnownHostEntry[]
  /** The open link to each host's target, kept for the live log tap. */
  links: Map<string, Client>
  /** Key identities the private agent must hold, once each. */
  keys: { privateKey: string; passphrase?: string }[]
  /** Some hop authenticates through the user's own agent or default keys. */
  userAgentNeeded: boolean
  /** Failures, each a blocking check. Empty when every host is ready. */
  checks: PreflightCheck[]
  close(): void
}

export interface PrepareDeps {
  resolve(hostId: string): ResolvedHost
  connectChain: typeof connectChain
  /** Defaults to Phase 4's verifyWithStore. */
  verify?: typeof verifyWithStore
  prompts: PromptBroker
  knownHosts: Pick<KnownHostStore, 'check' | 'trust' | 'recordMismatch'>
  identities: Pick<IdentityStore, 'resolve'>
  /** Environment, home and ~/.ssh/config lookup used for the agent / default key chain. */
  auth: Omit<AuthDeps, 'identities'>
  signal: AbortSignal
  timeoutMs?: number
}

const passwordMessage = (label: string): string => `Deploys need key or agent auth; "${label}" uses a password`

export async function prepareHosts(plan: DeployPlan, deps: PrepareDeps): Promise<PreparedHosts> {
  const links = new Map<string, Client>()
  const closers: (() => void)[] = []
  const entries = new Map<string, KnownHostEntry>()
  const keys: { privateKey: string; passphrase?: string }[] = []
  const seenIdentities = new Set<string>()
  const checks: PreflightCheck[] = []
  let userAgentNeeded = false
  let closed = false

  const close = (): void => {
    if (closed) return
    closed = true
    for (const c of closers.splice(0)) {
      try {
        c()
      } catch {
        // already closed
      }
    }
    links.clear()
  }
  const verify = deps.verify ?? verifyWithStore
  const authDeps: AuthDeps = { ...deps.auth, identities: deps.identities }

  try {
    for (const host of plan.hosts) {
      const block = (id: 'reachable' | 'auth', message: string): void => {
        checks.push({ id, deploymentId: null, hostId: host.hostId, label: host.label, level: 'block', message })
      }
      if (deps.signal.aborted) break
      let hops: HopTarget[]
      try {
        hops = hopsOf(deps.resolve(host.hostId), host.label)
      } catch (err) {
        block('reachable', err instanceof Error ? err.message : String(err))
        continue
      }
      // The generated ssh_config dials the plan's hops, so the plan is the one source of truth for addresses.
      if (hops.length !== host.hops.length || hops.some((h, i) => h.address !== host.hops[i].address || h.port !== host.hops[i].port)) {
        block('reachable', 'Host settings changed since the plan was built')
        continue
      }

      // Password identities are refused before anything is dialled.
      const pending: { privateKey: string; passphrase?: string; id: string }[] = []
      let agentNeeded = false
      let refused = false
      for (const hop of hops) {
        if (hop.identity.source === 'global') {
          agentNeeded = true
          continue
        }
        try {
          const r = await deps.identities.resolve(hop.identity.identityId)
          if (r.auth === 'password') {
            block('auth', passwordMessage(hop.label))
            refused = true
            break
          }
          if (r.auth === 'agent') agentNeeded = true
          else pending.push({ id: hop.identity.identityId, privateKey: r.privateKey, ...(r.passphrase ? { passphrase: r.passphrase } : {}) })
        } catch (err) {
          block('auth', `Couldn't read the credentials for "${hop.label}": ${err instanceof Error ? err.message : String(err)}`)
          refused = true
          break
        }
      }
      if (refused) continue

      let failed: HopTarget | null = null
      const recorded: KnownHostEntry[] = []
      const connectDeps: ConnectDeps = {
        plan: (identity, hop) => authPlan(identity, authDeps, { label: hop.label, address: hop.address }),
        verifyHostKey: async (hop, keyType, keyBase64) => {
          const ok = await verify(deps.knownHosts, deps.prompts, {
            ownerId: plan.releaseId,
            group: new Set<string>(),
            hop,
            hostId: host.hostId,
            keyType,
            keyBase64,
            isLive: () => !deps.signal.aborted,
            onLocked: () => {},
          })
          if (ok) {
            const planned = host.hops[hops.indexOf(hop)]
            recorded.push({ token: hostToken(planned.address, planned.port), keyType, keyBase64 })
          }
          return ok
        },
        askPassword: async () => null,
        askKeyboard: async () => null,
        onHop: (i, state) => {
          if (state === 'failed') failed = hops[i] ?? null
        },
        keepaliveSec: 15,
        readyTimeoutMs: deps.timeoutMs ?? PREPARE_DIAL_TIMEOUT_MS,
      }
      try {
        const chain = await deps.connectChain(hops, connectDeps, deps.signal)
        closers.push(() => chain.close())
        links.set(host.hostId, chain.client)
      } catch (err) {
        const hop = failed ?? hops[hops.length - 1] ?? null
        const e = describeError(err, hop, { user: false })
        block(err instanceof AuthFailedError || e.code === 'auth' ? 'auth' : 'reachable', e.message)
        continue
      }
      for (const e of recorded) entries.set(`${e.token} ${e.keyType} ${e.keyBase64}`, e)
      if (agentNeeded) userAgentNeeded = true
      for (const p of pending) {
        if (seenIdentities.has(p.id)) continue
        seenIdentities.add(p.id)
        keys.push({ privateKey: p.privateKey, ...(p.passphrase ? { passphrase: p.passphrase } : {}) })
      }
    }
  } catch (err) {
    close()
    throw err
  }
  if (deps.signal.aborted) close()
  return { knownHosts: [...entries.values()], links, keys, userAgentNeeded, checks, close }
}
