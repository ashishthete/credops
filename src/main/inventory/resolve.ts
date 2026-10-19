import {
  DEFAULT_SSH_PORT,
  MAX_JUMP_DEPTH,
  type IdentityRef,
  type InheritConflict,
  type ResolvedHop,
  type ResolvedHost,
  type ValueSource,
} from '../../shared/inventory'
import type { IdentityAuth } from '../../shared/vault'
import type { Db } from '../db/connection'
import { hostRow } from './rows'
import type { SshConfigMatch, SshConfigTarget } from './ssh-config'

export interface ResolveOptions {
  localUser: string
  /** ~/.ssh/config lookup; its User names a host that has no OpsDeck identity. */
  sshConfig?: (target: SshConfigTarget) => SshConfigMatch | null
}

type EnvDefaults = {
  id: string
  default_identity_id: string | null
  default_port: number | null
  default_jump_host_id: string | null
}

interface Fields {
  port: ResolvedHost['port']
  identity: IdentityRef
  jump: ResolvedHost['jump']
}

const isMember = (db: Db, environmentId: string, hostId: string): boolean =>
  db.prepare('SELECT 1 FROM environment_hosts WHERE environment_id = ? AND host_id = ?').get(environmentId, hostId) !== undefined

function envDefaults(db: Db, environmentId: string): EnvDefaults {
  const row = db
    .prepare('SELECT id, default_identity_id, default_port, default_jump_host_id FROM environments WHERE id = ?')
    .get(environmentId) as EnvDefaults | undefined
  if (!row) throw new Error('environment not found')
  return row
}

/** Reads only the identity's public columns: never a `*_enc` one. */
function identityRef(db: Db, id: string, source: 'host' | 'environment'): IdentityRef {
  const row = db.prepare('SELECT label, username, auth, vault_id FROM identities WHERE id = ?').get(id) as
    | { label: string; username: string; auth: IdentityAuth; vault_id: string }
    | undefined
  if (!row) throw new Error('identity not found')
  return { source, identityId: id, label: row.label, username: row.username, auth: row.auth, vaultId: row.vault_id }
}

/** Host's own value, then the environment's default (only in a context), then the global one. */
function resolveFields(db: Db, hostId: string, environmentId: string | null, opts: ResolveOptions): Fields {
  const host = hostRow(db, hostId)
  const env = environmentId === null ? null : envDefaults(db, environmentId)
  const pick = <T>(own: T | null, inherited: T | null | undefined): { value: T; source: 'host' | 'environment' } | null =>
    own !== null ? { value: own, source: 'host' } : inherited != null ? { value: inherited, source: 'environment' } : null

  const port = pick(host.port, env?.default_port) ?? { value: DEFAULT_SSH_PORT, source: 'global' as ValueSource }
  const id = pick(host.identity_id, env?.default_identity_id)
  const identity: IdentityRef = id ? identityRef(db, id.value, id.source) : globalIdentity(host, opts)
  const j = pick(host.jump_host_id, env?.default_jump_host_id)
  // A bastion never routes through itself.
  const jump = j && j.value !== hostId ? { hostId: j.value, source: j.source } : { hostId: null, source: null }
  return { port, identity, jump }
}

/** Like `ssh <host>`: the matching ~/.ssh/config block's User, else the local user. */
function globalIdentity(host: { label: string; address: string }, opts: ResolveOptions): IdentityRef {
  const user = opts.sshConfig?.({ label: host.label, address: host.address })?.user ?? null
  return user === null
    ? { source: 'global', username: opts.localUser, auth: 'default' }
    : { source: 'global', username: user, auth: 'default', userSource: 'ssh-config' }
}

/**
 * How to reach `hostId`, opened from `environmentId` or outside any environment. Each field says where it
 * came from. Works while locked: it reads labels, usernames and ids, never a secret.
 */
export function resolveHost(
  db: Db,
  hostId: string,
  environmentId: string | undefined,
  opts: ResolveOptions,
): ResolvedHost {
  const host = hostRow(db, hostId)
  if (environmentId !== undefined && !isMember(db, environmentId, hostId)) throw new Error('host is not in that environment')
  const own = resolveFields(db, hostId, environmentId ?? null, opts)

  const chain: ResolvedHop[] = []
  const path = [{ id: host.id, label: host.label }]
  let next = own.jump.hostId
  while (next !== null) {
    const hop = hostRow(db, next)
    if (path.some((p) => p.id === hop.id)) {
      throw new Error(`jump host loop: ${[...path.map((p) => p.label), hop.label].join(' → ')}`)
    }
    if (chain.length === MAX_JUMP_DEPTH) throw new Error(`jump chain is longer than ${MAX_JUMP_DEPTH} hops`)
    path.push({ id: hop.id, label: hop.label })
    // A hop takes the context only when it is a member of that environment.
    const context = environmentId !== undefined && isMember(db, environmentId, hop.id) ? environmentId : null
    const f = resolveFields(db, hop.id, context, opts)
    chain.unshift({ hostId: hop.id, label: hop.label, address: hop.address, port: f.port.value, identity: f.identity })
    next = f.jump.hostId
  }

  return {
    hostId,
    environmentId: environmentId ?? null,
    address: host.address,
    port: own.port,
    identity: own.identity,
    jump: own.jump,
    chain,
    conflicts: inheritConflicts(db, hostId),
  }
}

/**
 * Fields the host leaves unset whose defaults differ across its environments (`null` counts as a value).
 * Reported whatever the context, so the UI can ask the host to set the field itself.
 */
export function inheritConflicts(db: Db, hostId: string): InheritConflict[] {
  const host = hostRow(db, hostId)
  const envs = db
    .prepare(
      `SELECT e.id, e.default_identity_id, e.default_port, e.default_jump_host_id FROM environments e
        JOIN environment_hosts eh ON eh.environment_id = e.id WHERE eh.host_id = ? ORDER BY e.id`,
    )
    .all(hostId) as EnvDefaults[]
  if (envs.length < 2) return []
  const environmentIds = envs.map((e) => e.id)
  const fields: [InheritConflict['field'], unknown, (e: EnvDefaults) => unknown][] = [
    ['identity', host.identity_id, (e) => e.default_identity_id],
    ['port', host.port, (e) => e.default_port],
    // A default naming the host itself means no jump for it (a host never jumps through itself).
    ['jumpHost', host.jump_host_id, (e) => (e.default_jump_host_id === hostId ? null : e.default_jump_host_id)],
  ]
  return fields
    .filter(([, own, get]) => own === null && new Set(envs.map(get)).size > 1)
    .map(([field]) => ({ field, environmentIds }))
}
