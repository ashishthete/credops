import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import {
  MAX_SSH_CONFIG_BYTES,
  type HostMeta,
  type SshConfigEntry,
  type SshImportCandidate,
  type SshImportPreview,
  type SshImportRequest,
  type SshImportResult,
} from '../../shared/inventory'
import { MAX_LABEL, VAULT_LOCKED, type SshKeyMeta } from '../../shared/vault'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import { inTransaction } from '../db/tx'
import type { IdentityStore } from '../vault/identity-store'
import type { KeyStore } from '../vault/key-store'
import type { VaultService } from '../vault/vault-service'
import { findJumpLoop, type HostStore } from './host-store'
import { isValidAddress, isValidLabel } from './rows'
import { parseSshConfig, readSshIncludes } from './ssh-config'

export interface SshImporterDeps {
  db: Db
  vault: VaultService
  audit: AuditLog
  hosts: HostStore
  keys: KeyStore
  identities: IdentityStore
  sshConfigPath: string
  sshDir: string
  home: string
  /** The username an identity gets when the entry has an IdentityFile but no User. */
  localUser: string
}

const INVALID_ADDRESS = "address isn't a plain hostname or IP; skipped"
const INVALID_ALIAS = "alias isn't a usable host label; skipped"
const JUMP_CHAIN = "ProxyJump chains aren't imported; set the jump host by hand"
/** One ProxyJump hop, `[user@]host[:port]`. */
const HOP = /^(?:([^@\s]+)@)?([^@:\s[\]]+)(?::(\d+))?$/
const CONTROL = /[\x00-\x1f\x7f]/

/** Where a candidate's resolvable ProxyJump points: another candidate alias, or an existing host. */
type JumpPlan = { alias: string } | { hostId: string }

interface Loaded {
  found: boolean
  candidates: SshImportCandidate[]
  warnings: string[]
  jumps: Map<string, JumpPlan>
}

const isInside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Imports hosts from ~/.ssh/config. Both calls re-read and re-parse the file, so the renderer only
 * ever sends aliases. Hosts match existing ones by label only (case-insensitive).
 */
export class SshImporter {
  constructor(private readonly deps: SshImporterDeps) {}

  /** Works while locked: reads the config and host labels only. */
  async preview(): Promise<SshImportPreview> {
    const { found, candidates, warnings } = await this.load()
    return { path: this.deps.sshConfigPath, found, candidates, warnings }
  }

  async import(req: SshImportRequest): Promise<SshImportResult> {
    const { db, vault, audit, hosts } = this.deps
    vault.assertUnlocked()
    this.checkTargets(req)
    const { candidates, jumps } = await this.load()
    const byAlias = new Map(candidates.map((c) => [c.alias, c]))
    const skipped: SshImportResult['skipped'] = []
    const toCreate: SshImportCandidate[] = []
    for (const alias of new Set(req.aliases)) {
      const c = byAlias.get(alias)
      if (!c) skipped.push({ alias, reason: 'not-found' })
      else if (!c.valid) skipped.push({ alias, reason: 'invalid' })
      else if (c.existingHostId !== null) skipped.push({ alias, reason: 'exists' })
      else toCreate.push(c)
    }

    // Before the transaction: link is async. These rows stay (audited by their stores) if it fails.
    const warnings: string[] = []
    const { keyFor, keysLinked } = await this.linkKeys(req.vaultId, toCreate, warnings)
    const { identityFor, identitiesCreated } = this.makeIdentities(req.vaultId, toCreate, keyFor, warnings)

    // The vault may have locked while key files were read.
    vault.assertUnlocked()
    const environments = req.environmentId ? [{ environmentId: req.environmentId, role: req.role ?? 'other' }] : []
    const ids = inTransaction(db, () => {
      const idByAlias = new Map<string, string>()
      for (const c of toCreate) {
        const identityId = identityFor.get(c.alias) ?? null
        const id = hosts.insertInTx({
          label: c.alias,
          address: c.hostName,
          port: c.port,
          identityId,
          vaultIds: identityId ? [req.vaultId] : [],
          environments,
        })
        idByAlias.set(c.alias, id)
      }
      for (const c of toCreate) {
        const plan = jumps.get(c.alias)
        if (!plan) continue
        const hostId = idByAlias.get(c.alias)!
        let jumpId: string | null
        if ('hostId' in plan) jumpId = plan.hostId
        else {
          jumpId = idByAlias.get(plan.alias) ?? byAlias.get(plan.alias)!.existingHostId
          if (jumpId === null) {
            warnings.push(`${c.alias}: jump host ${plan.alias} wasn't imported; set it by hand`)
            continue
          }
        }
        const loop = findJumpLoop(db, hostId, jumpId)
        if (loop) {
          warnings.push(`jump host loop: ${loop.join(' → ')}; ${c.alias} was imported without its jump host`)
          continue
        }
        db.prepare('UPDATE hosts SET jump_host_id = ? WHERE id = ?').run(jumpId, hostId)
      }
      return [...idByAlias.values()]
    })

    const created: HostMeta[] = ids.map((id) => hosts.auditCreated(id, { source: 'ssh_config' }))
    audit.append({
      action: 'host.import',
      outcome: 'success',
      targetType: 'ssh_config',
      details: { created: created.length, skipped: skipped.length, keysLinked, identitiesCreated },
    })
    return { created, skipped, keysLinked, identitiesCreated, warnings }
  }

  /** Fails before any key or identity is made, so a bad target leaves no rows behind. */
  private checkTargets(req: SshImportRequest): void {
    const { db, vault } = this.deps
    if (!db.prepare('SELECT 1 FROM vaults WHERE id = ?').get(req.vaultId)) throw new Error('vault not found')
    if (vault.isCorrupt(req.vaultId)) throw new Error('vault key is corrupt')
    if (req.environmentId !== undefined && !db.prepare('SELECT 1 FROM environments WHERE id = ?').get(req.environmentId)) {
      throw new Error('environment not found')
    }
  }

  private async load(): Promise<Loaded> {
    const { sshConfigPath, sshDir, home, db } = this.deps
    const empty = (found: boolean, warnings: string[] = []): Loaded => ({ found, candidates: [], warnings, jumps: new Map() })
    let rootPath: string
    let text: string
    try {
      rootPath = await realpath(sshConfigPath)
      const st = await stat(rootPath)
      if (!st.isFile()) return empty(true, ['ssh config is not a regular file'])
      if (st.size > MAX_SSH_CONFIG_BYTES) return empty(true, ['ssh config is larger than 1 MiB'])
      text = await readFile(rootPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty(false)
      return empty(true, ['ssh config could not be read'])
    }
    const parsed = parseSshConfig(text, { home, sshDir, include: readSshIncludes(sshDir), rootPath })

    const labelId = db.prepare('SELECT id FROM hosts WHERE label = ? ORDER BY id LIMIT 1') // label is COLLATE NOCASE
    const existingId = (label: string): string | null => (labelId.get(label) as { id: string } | undefined)?.id ?? null
    const firstByCase = new Map<string, string>()
    const candidates = parsed.entries.map((e): SshImportCandidate => {
      const warnings = [...e.warnings]
      let valid = true
      if (!isValidLabel(e.alias) || e.alias.startsWith('-') || CONTROL.test(e.alias)) {
        valid = false
        warnings.push(INVALID_ALIAS)
      }
      if (!isValidAddress(e.hostName)) {
        valid = false
        warnings.push(INVALID_ADDRESS)
      }
      // Host labels are unique case-insensitively; the parser matches aliases case-sensitively.
      if (valid) {
        const first = firstByCase.get(e.alias.toLowerCase())
        if (first === undefined) firstByCase.set(e.alias.toLowerCase(), e.alias)
        else {
          valid = false
          warnings.push(`alias differs from ${first} only by case; skipped`)
        }
      }
      if (e.forwards.length > 0) {
        const n = e.forwards.length
        warnings.push(`${n} port forward${n === 1 ? '' : 's'} will be offered when Tunnels arrive`)
      }
      return { ...e, warnings, valid, existingHostId: existingId(e.alias), jumpResolvable: false }
    })

    const byAlias = new Map(candidates.map((c) => [c.alias, c]))
    const jumps = new Map<string, JumpPlan>()
    for (const c of candidates) {
      const plan = this.planJump(c, byAlias, existingId)
      if (plan) {
        c.jumpResolvable = true
        jumps.set(c.alias, plan)
      }
    }
    return { found: true, candidates, warnings: parsed.warnings, jumps }
  }

  /** A single-hop ProxyJump to another usable candidate or an existing host; adds the warnings otherwise. */
  private planJump(
    c: SshImportCandidate,
    byAlias: Map<string, SshImportCandidate>,
    existingId: (label: string) => string | null,
  ): JumpPlan | null {
    if (c.proxyJump === null) return null
    if (c.proxyJump.includes(',')) {
      c.warnings.push(JUMP_CHAIN)
      return null
    }
    const m = HOP.exec(c.proxyJump)
    const target = m?.[2]
    const other = target === undefined || target === c.alias ? undefined : byAlias.get(target)
    let plan: JumpPlan | null = null
    if (other && (other.valid || other.existingHostId !== null)) plan = { alias: other.alias }
    else if (target !== undefined && target !== c.alias && !other) {
      const id = existingId(target)
      if (id !== null) plan = { hostId: id }
    }
    if (!plan) {
      c.warnings.push(`ProxyJump ${c.proxyJump} isn't a host in this config or OpsDeck; set the jump host by hand`)
      return null
    }
    if (m![1] !== undefined || m![3] !== undefined) {
      c.warnings.push(`ProxyJump user and port aren't imported; ${target}'s own settings are used`)
    }
    return plan
  }

  /** One key per distinct IdentityFile: reused when the vault already links that path, else linked. */
  private async linkKeys(
    vaultId: string,
    entries: SshConfigEntry[],
    warnings: string[],
  ): Promise<{ keyFor: Map<string, SshKeyMeta>; keysLinked: number }> {
    const { keys, sshDir } = this.deps
    const keyFor = new Map<string, SshKeyMeta>()
    let keysLinked = 0
    const files = [...new Set(entries.map((e) => e.identityFile).filter((p): p is string => p !== null))]
    if (files.length === 0) return { keyFor, keysLinked }
    const linked = keys.list(vaultId).filter((k) => k.source === 'file' && k.filePath !== null)
    for (const path of files) {
      // KeyStore stores resolve()d paths, so compare those, not realpaths.
      const reuse = linked.find((k) => resolve(k.filePath!) === resolve(path))
      if (reuse) {
        keyFor.set(path, reuse)
        continue
      }
      const fallback = 'hosts using it fall back to agent auth'
      const where = await this.confine(path)
      if (where === 'missing') {
        warnings.push(`IdentityFile ${path} doesn't exist; ${fallback}`)
        continue
      }
      if (where === 'outside') {
        warnings.push(`IdentityFile ${path} resolves outside ${sshDir}; ${fallback}`)
        continue
      }
      try {
        keyFor.set(path, await keys.link({ vaultId, label: basename(path), path }))
        keysLinked++
      } catch (err) {
        const msg = err instanceof Error ? err.message : ''
        if (msg === VAULT_LOCKED) throw err
        // Store messages carry no key material, but only known ones are shown.
        warnings.push(
          msg === 'passphrase required'
            ? `Key ${path} needs a passphrase, so link it in Keys; ${fallback}`
            : `Key ${path} couldn't be linked; ${fallback}`,
        )
      }
    }
    return { keyFor, keysLinked }
  }

  /** Real-path confinement to sshDir, checked before KeyStore ever opens the file. */
  private async confine(path: string): Promise<'inside' | 'outside' | 'missing'> {
    let root: string
    let real: string
    try {
      root = await realpath(this.deps.sshDir)
      real = await realpath(path)
    } catch {
      return 'missing'
    }
    return isInside(root, real) ? 'inside' : 'outside'
  }

  /**
   * One identity per distinct (username, key): reused when the vault has one with the same username,
   * auth and key. An entry with neither User nor IdentityFile gets none, so the host inherits.
   */
  private makeIdentities(
    vaultId: string,
    entries: SshConfigEntry[],
    keyFor: Map<string, SshKeyMeta>,
    warnings: string[],
  ): { identityFor: Map<string, string>; identitiesCreated: number } {
    const { identities, localUser } = this.deps
    const identityFor = new Map<string, string>()
    const done = new Map<string, string | null>()
    let identitiesCreated = 0
    let existing: ReturnType<IdentityStore['list']> | null = null
    for (const e of entries) {
      if (e.user === null && e.identityFile === null) continue
      const key = e.identityFile === null ? undefined : keyFor.get(e.identityFile)
      const username = e.user ?? localUser
      const auth = key ? ('key' as const) : ('agent' as const)
      const pair = `${username}\0${key?.id ?? ''}`
      let id = done.get(pair)
      if (id === undefined) {
        existing ??= identities.list(vaultId)
        id = existing.find((i) => i.username === username && i.auth === auth && i.sshKeyId === (key?.id ?? null))?.id ?? null
        if (id === null) {
          const label = (key ? `${username} · ${key.label}` : username).slice(0, MAX_LABEL)
          try {
            id = identities.create({ vaultId, label, username, auth, sshKeyId: key?.id }).id
            identitiesCreated++
          } catch (err) {
            if (err instanceof Error && err.message === VAULT_LOCKED) throw err
            warnings.push(`${e.alias}: no identity could be made for its User; the host inherits one`)
          }
        }
        done.set(pair, id)
      }
      if (id !== null) identityFor.set(e.alias, id)
    }
    return { identityFor, identitiesCreated }
  }
}
