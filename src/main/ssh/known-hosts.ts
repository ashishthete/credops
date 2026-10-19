import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { open } from 'node:fs/promises'
import { MAX_KNOWN_HOSTS_BYTES, type HostKeyInfo, type KnownHostMeta } from '../../shared/ssh'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import { globMatch } from '../inventory/ssh-config'
import type { VaultService } from '../vault/vault-service'

/** Per-match allowance for wildcard matching, so a hostile file cannot stall a check. */
const GLOB_STEPS_PER_MATCH = 100_000
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

export type HostKeyStatus = 'match' | 'unknown' | 'changed' | 'revoked'

export interface KnownHostLine {
  /** 1-based. */
  line: number
  marker: 'revoked' | 'cert-authority' | null
  matches(token: string): boolean
  keyType: string
  key: string
}

/** The OpenSSH host token: bare address on port 22, `[address]:port` otherwise, lowercased. */
export function hostToken(address: string, port: number): string {
  const a = address.toLowerCase()
  return port === 22 ? a : `[${a}]:${port}`
}

/** OpenSSH style: `SHA256:` plus the unpadded base64 of the raw key's SHA-256. */
export function fingerprintOf(keyBase64: string): string {
  const digest = createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('base64')
  return `SHA256:${digest.replace(/=+$/, '')}`
}

function hashedMatcher(field: string): ((token: string) => boolean) | null {
  const [empty, version, salt, hash] = field.split('|')
  if (empty !== '' || version !== '1' || !salt || !hash || !BASE64.test(salt) || !BASE64.test(hash)) return null
  const saltBuf = Buffer.from(salt, 'base64')
  const want = Buffer.from(hash, 'base64')
  return (token) => {
    const got = createHmac('sha1', saltBuf).update(token).digest()
    return got.length === want.length && timingSafeEqual(got, want)
  }
}

function patternMatcher(field: string): ((token: string) => boolean) | null {
  const patterns = field.toLowerCase().split(',').filter(Boolean)
  if (!patterns.length) return null
  return (token) => {
    let positive = false
    for (const p of patterns) {
      if (p.startsWith('!')) {
        if (globMatch(p.slice(1), token, { steps: GLOB_STEPS_PER_MATCH })) return false
      } else if (globMatch(p, token, { steps: GLOB_STEPS_PER_MATCH })) positive = true
    }
    return positive
  }
}

/** OpenSSH rejects non-canonical base64, and a label that disagrees with the blob's own type string. */
function canonicalKey(key: string, keyType: string): boolean {
  if (!BASE64.test(key)) return false
  const blob = Buffer.from(key, 'base64')
  if (blob.toString('base64') !== key || blob.length < 4) return false
  const len = blob.readUInt32BE(0)
  return len <= blob.length - 4 && blob.toString('latin1', 4, 4 + len) === keyType
}

/** Malformed lines and unknown `@markers` are skipped; line numbers still count them. */
export function parseKnownHosts(text: string): KnownHostLine[] {
  const out: KnownHostLine[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const parts = trimmed.split(/\s+/)
    let marker: KnownHostLine['marker'] = null
    if (parts[0].startsWith('@')) {
      if (parts[0] === '@revoked') marker = 'revoked'
      else if (parts[0] === '@cert-authority') marker = 'cert-authority'
      else continue
      parts.shift()
    }
    if (parts.length < 3) continue
    const [hostField, keyType, key] = parts
    if (!canonicalKey(key, keyType)) continue
    const matches = hostField.startsWith('|') ? hashedMatcher(hostField) : patternMatcher(hostField)
    if (matches) out.push({ line: i + 1, marker, matches, keyType, key })
  }
  return out
}

interface Row {
  id: string
  host: string
  key_type: string
  key: string
  fingerprint: string
  first_seen: string
  last_seen: string
}

const meta = (r: Row): KnownHostMeta => ({
  id: r.id,
  host: r.host,
  keyType: r.key_type,
  fingerprint: r.fingerprint,
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
})

/**
 * Host key trust: `~/.ssh/known_hosts` is read only; trust decisions are kept in the app's
 * `known_hosts` table. A key is known if either source has it.
 */
export class KnownHostStore {
  private readonly knownHostsPath: string
  private readonly now: () => Date
  private warnedOversize = false
  private warnedRead = false

  constructor(
    private readonly db: Db,
    private readonly vault: VaultService,
    private readonly audit: AuditLog,
    opts: { knownHostsPath: string; now?: () => Date },
  ) {
    this.knownHostsPath = opts.knownHostsPath
    this.now = opts.now ?? ((): Date => new Date())
  }

  async check(
    address: string,
    port: number,
    keyType: string,
    keyBase64: string,
  ): Promise<{ status: HostKeyStatus; info: HostKeyInfo }> {
    const token = hostToken(address, port)
    const lines = (await this.readLines()).filter((l) => l.marker !== 'cert-authority' && l.matches(token))
    const rows = this.db.prepare('SELECT * FROM known_hosts WHERE host = ?').all(token) as unknown as Row[]

    const known: HostKeyInfo['known'] = []
    let revoked = false
    let match = false
    let changed = false
    for (const l of lines) {
      if (l.marker === 'revoked') {
        if (l.key === keyBase64) revoked = true
        continue
      }
      known.push({ keyType: l.keyType, fingerprint: fingerprintOf(l.key), source: 'openssh', line: l.line })
      if (l.keyType === keyType) {
        if (l.key === keyBase64) match = true
        else changed = true
      }
    }
    let appMatch: Row | undefined
    for (const r of rows) {
      known.push({ keyType: r.key_type, fingerprint: r.fingerprint, source: 'app' })
      if (r.key_type === keyType) {
        if (r.key === keyBase64) {
          match = true
          appMatch = r
        } else changed = true
      }
    }

    const status: HostKeyStatus = revoked ? 'revoked' : match ? 'match' : changed ? 'changed' : 'unknown'
    if (status === 'match' && appMatch) {
      this.db.prepare('UPDATE known_hosts SET last_seen = ? WHERE id = ?').run(this.now().toISOString(), appMatch.id)
    }
    return { status, info: { host: token, keyType, fingerprint: fingerprintOf(keyBase64), known } }
  }

  trust(address: string, port: number, keyType: string, keyBase64: string): KnownHostMeta {
    this.vault.assertUnlocked()
    const host = hostToken(address, port)
    const fingerprint = fingerprintOf(keyBase64)
    const ts = this.now().toISOString()
    this.db
      .prepare(
        `INSERT INTO known_hosts(id, host, key_type, key, fingerprint, first_seen, last_seen)
          VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(host, key_type) DO UPDATE SET
            key = excluded.key, fingerprint = excluded.fingerprint,
            first_seen = excluded.first_seen, last_seen = excluded.last_seen`,
      )
      .run(randomUUID(), host, keyType, keyBase64, fingerprint, ts, ts)
    const row = this.db.prepare('SELECT * FROM known_hosts WHERE host = ? AND key_type = ?').get(host, keyType) as unknown as Row
    this.audit.append({
      action: 'knownhost.trust',
      outcome: 'success',
      targetType: 'knownhost',
      targetId: row.id,
      targetLabel: host,
      details: { keyType, fingerprint },
    })
    return meta(row)
  }

  /**
   * The pinned keys for one address as plain known_hosts lines (public keys only): the app's own rows plus
   * unhashed-or-matching lines from the OpenSSH file. Revoked and cert-authority entries are not pins.
   */
  async pinned(address: string, port: number): Promise<string[]> {
    const token = hostToken(address, port)
    const lines = new Set<string>()
    const file = await this.readLines()
    // Like check(): a key the OpenSSH file revokes is not a pin, whichever source holds it.
    const revoked = new Set(file.filter((l) => l.marker === 'revoked' && l.matches(token)).map((l) => l.key))
    for (const r of this.db.prepare('SELECT key_type, key FROM known_hosts WHERE host = ?').all(token) as unknown as Pick<Row, 'key_type' | 'key'>[]) {
      if (!revoked.has(r.key)) lines.add(`${token} ${r.key_type} ${r.key}`)
    }
    for (const l of file) {
      if (l.marker === null && l.matches(token) && !revoked.has(l.key)) lines.add(`${token} ${l.keyType} ${l.key}`)
    }
    return [...lines].sort()
  }

  /** Works while locked. */
  list(): KnownHostMeta[] {
    const rows = this.db.prepare('SELECT * FROM known_hosts ORDER BY host, key_type').all() as unknown as Row[]
    return rows.map(meta)
  }

  remove(id: string): void {
    this.vault.assertUnlocked()
    const row = this.db.prepare('SELECT * FROM known_hosts WHERE id = ?').get(id) as unknown as Row | undefined
    if (!row) throw new Error('known host not found')
    this.db.prepare('DELETE FROM known_hosts WHERE id = ?').run(id)
    this.audit.append({
      action: 'knownhost.remove',
      outcome: 'success',
      targetType: 'knownhost',
      targetId: id,
      targetLabel: row.host,
      details: { keyType: row.key_type, fingerprint: row.fingerprint },
    })
  }

  recordMismatch(info: HostKeyInfo, hostId: string | null): void {
    this.audit.append({
      action: 'knownhost.mismatch',
      outcome: 'denied',
      targetType: 'knownhost',
      ...(hostId ? { targetId: hostId } : {}),
      targetLabel: info.host,
      details: { keyType: info.keyType, fingerprint: info.fingerprint },
    })
  }

  /** Missing, unreadable or oversized files count as empty; an unreadable one warns once. */
  private async readLines(): Promise<KnownHostLine[]> {
    try {
      const fh = await open(this.knownHostsPath, 'r')
      try {
        const cap = MAX_KNOWN_HOSTS_BYTES
        const buf = Buffer.alloc(cap + 1)
        let n = 0
        while (n <= cap) {
          const { bytesRead } = await fh.read(buf, n, cap + 1 - n, n)
          if (bytesRead === 0) break
          n += bytesRead
        }
        if (n > cap) {
          if (!this.warnedOversize) {
            this.warnedOversize = true
            console.warn('known_hosts is larger than 4 MiB; skipped')
          }
          return []
        }
        return parseKnownHosts(buf.toString('utf8', 0, n))
      } finally {
        await fh.close()
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && !this.warnedRead) {
        this.warnedRead = true
        console.warn(`known_hosts could not be read (${code ?? 'unknown error'})`)
      }
      return []
    }
  }
}
