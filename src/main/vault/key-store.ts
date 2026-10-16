import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  MAX_KEY_COMMENT,
  MAX_LABEL,
  MAX_PASSPHRASE,
  type KeyGenerateInput,
  type KeyImportInput,
  type KeyLinkInput,
  type LocalKeyCandidate,
  type SshKeyMeta,
  type SshKeySource,
  type SshKeyType,
} from '../../shared/vault'
import type { AuditLog } from '../audit/audit-log'
import type { Db } from '../db/connection'
import {
  fingerprintOf,
  generateEd25519,
  MAX_PRIVATE_KEY_BYTES,
  parsePrivateKey,
  parsePublicKeyLine,
  type ParsedKey,
} from './openssh'
import type { ClipboardLike } from './types'
import type { VaultService } from './vault-service'

/** The VaultService known-values source this store owns. */
const KNOWN_SOURCE = 'keys'

/** Files in ~/.ssh that are never private keys: not even read by the scan. */
const NOT_A_KEY = /^(known_hosts.*|config|authorized_keys.*|.*\.pub)$/
const PRIVATE_HEADER = /^-----BEGIN [A-Z ]*PRIVATE KEY-----/
const CONTROL = /[\x00-\x1f\x7f]/

interface KeyRow {
  id: string
  vault_id: string
  label: string
  key_type: SshKeyType
  public_key: string
  fingerprint: string
  private_key_enc: string | null
  passphrase_enc: string | null
  source: SshKeySource
  file_path: string | null
  created_at: string
  updated_at: string
}

const privateAad = (id: string): string => `key:${id}:private`
const passphraseAad = (id: string): string => `key:${id}:passphrase`

function toMeta(r: KeyRow): SshKeyMeta {
  return {
    id: r.id,
    vaultId: r.vault_id,
    label: r.label,
    keyType: r.key_type,
    publicKey: r.public_key,
    fingerprint: r.fingerprint,
    source: r.source,
    filePath: r.file_path,
    hasPassphrase: r.passphrase_enc !== null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function checkLabel(raw: string): string {
  const label = typeof raw === 'string' ? raw.trim() : ''
  if (label.length === 0 || label.length > MAX_LABEL) throw new Error(`key label must be 1-${MAX_LABEL} characters`)
  return label
}

/** The message never carries the passphrase. */
function checkPassphrase(passphrase: string | undefined): string | undefined {
  if (passphrase === undefined) return undefined
  if (typeof passphrase !== 'string' || passphrase.length === 0 || passphrase.length > MAX_PASSPHRASE) {
    throw new Error(`passphrase must be 1-${MAX_PASSPHRASE} characters`)
  }
  return passphrase
}

/**
 * Parses and requires a passphrase exactly when the key is encrypted, so `hasPassphrase` means
 * "the key is encrypted". An openssh-key-v1 passphrase is not checked here: ssh2 checks it when
 * it connects (Phase 4). A PEM passphrase is checked by parsePrivateKey.
 */
function parseKey(text: string, passphrase: string | undefined): ParsedKey {
  if (Buffer.byteLength(text, 'utf8') > MAX_PRIVATE_KEY_BYTES) throw new Error('private key is too large')
  const parsed = parsePrivateKey(text, passphrase)
  if (parsed.encrypted && passphrase === undefined) throw new Error('passphrase required')
  if (!parsed.encrypted && passphrase !== undefined) throw new Error('key is not encrypted: leave the passphrase empty')
  return parsed
}

/** The public key line with the key's comment, when it has a printable one. */
function publicLine(parsed: { publicKey: string; comment: string }): string {
  const { comment } = parsed
  if (!comment || comment.length > MAX_KEY_COMMENT || CONTROL.test(comment)) return parsed.publicKey
  return `${parsed.publicKey} ${comment}`
}

const isInside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Reads a key file through one handle: the size and type checked are those of the file read, so
 * a file swapped or grown after a check is still refused, and at most MAX_PRIVATE_KEY_BYTES + 1
 * bytes are read. Unless `follow`, a symlink is refused (O_NOFOLLOW). O_NONBLOCK keeps a FIFO
 * from hanging the open.
 */
async function readKeyFile(path: string, opts: { follow: boolean }): Promise<string> {
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (opts.follow ? 0 : (constants.O_NOFOLLOW ?? 0))
  let fh: FileHandle
  try {
    fh = await open(path, flags)
  } catch {
    throw new Error('cannot read key file')
  }
  try {
    let size: number
    try {
      const st = await fh.stat()
      if (!st.isFile()) throw new Error('not a file')
      size = st.size
    } catch {
      throw new Error('cannot read key file')
    }
    if (size > MAX_PRIVATE_KEY_BYTES) throw new Error('key file is too large')
    const buf = Buffer.alloc(MAX_PRIVATE_KEY_BYTES + 1)
    let n = 0
    try {
      for (;;) {
        const { bytesRead } = await fh.read(buf, n, buf.length - n, n)
        if (bytesRead === 0) break
        n += bytesRead
        if (n === buf.length) break
      }
    } catch {
      throw new Error('cannot read key file')
    }
    if (n > MAX_PRIVATE_KEY_BYTES) throw new Error('key file is too large')
    return buf.subarray(0, n).toString('utf8')
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/**
 * SSH keys in the vaults. A linked key ('file') stores only its path and public key and is read
 * from ~/.ssh when used; imported and generated keys are sealed per vault with AAD
 * `key:<id>:private`, passphrases with `key:<id>:passphrase`. Private keys leave the store only
 * through material() (main only). Decrypted passphrases are registered with the vault for
 * redaction; private key text is caught by the redactor's PEM rule.
 */
export class KeyStore {
  readonly sshDir: string
  private readonly clipboard: ClipboardLike
  private readonly defaultComment: string
  /** Whether this unlock's passphrases are registered with the vault. */
  private loaded = false

  constructor(
    private readonly db: Db,
    private readonly vault: VaultService,
    private readonly audit: AuditLog,
    deps: { sshDir: string; clipboard: ClipboardLike; defaultComment: string },
  ) {
    this.sshDir = deps.sshDir
    this.clipboard = deps.clipboard
    this.defaultComment = deps.defaultComment
    vault.onLock(() => {
      this.loaded = false
    })
  }

  /** Works while locked: public keys and labels are not secret. Sorted by label. */
  list(vaultId?: string): SshKeyMeta[] {
    const order = 'ORDER BY label COLLATE NOCASE, label, id'
    const rows = (
      vaultId === undefined
        ? this.db.prepare(`SELECT * FROM ssh_keys ${order}`).all()
        : this.db.prepare(`SELECT * FROM ssh_keys WHERE vault_id = ? ${order}`).all(vaultId)
    ) as unknown as KeyRow[]
    return rows.map(toMeta)
  }

  /**
   * Private keys directly in ~/.ssh, sorted by path. Needs no unlock and never throws: an
   * unreadable entry is skipped. Only regular files up to MAX_PRIVATE_KEY_BYTES that are not
   * known config/public files are read.
   */
  async scanLocal(): Promise<LocalKeyCandidate[]> {
    let names: string[]
    try {
      const entries = await readdir(this.sshDir, { withFileTypes: true })
      names = entries.filter((e) => e.isFile() && !NOT_A_KEY.test(e.name)).map((e) => e.name)
    } catch {
      return []
    }
    const linked = new Set(
      (this.db.prepare("SELECT file_path FROM ssh_keys WHERE source = 'file'").all() as { file_path: string }[]).map(
        (r) => r.file_path,
      ),
    )
    const found: LocalKeyCandidate[] = []
    for (const name of names) {
      const path = join(this.sshDir, name)
      try {
        // Pre-check so an oversized file is never even opened; readKeyFile checks the handle again.
        const st = await lstat(path)
        if (!st.isFile() || st.size > MAX_PRIVATE_KEY_BYTES) continue
        const text = await readKeyFile(path, { follow: false })
        if (!PRIVATE_HEADER.test(text)) continue
        const { keyType, fingerprint, encrypted } = await this.identify(path, text)
        found.push({ path, keyType, fingerprint, encrypted, alreadyLinked: linked.has(path) })
      } catch {
        // Unreadable, or not a key we support.
      }
    }
    return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }

  /** Stores the path and public key only; the file must resolve inside ~/.ssh. */
  async link(input: KeyLinkInput): Promise<SshKeyMeta> {
    this.vault.assertUnlocked()
    this.assertUsable(input.vaultId)
    const label = checkLabel(input.label)
    const passphrase = checkPassphrase(input.passphrase)
    const path = resolve(input.path)
    const parsed = parseKey(await this.readLinked(path), passphrase)
    // The vault may have locked while the file was read.
    this.vault.assertUnlocked()
    this.assertUsable(input.vaultId)
    return this.insert({ vaultId: input.vaultId, label, parsed, source: 'file', path, passphrase })
  }

  import(input: KeyImportInput): SshKeyMeta {
    this.vault.assertUnlocked()
    this.assertUsable(input.vaultId)
    const label = checkLabel(input.label)
    const passphrase = checkPassphrase(input.passphrase)
    if (typeof input.privateKey !== 'string') throw new Error('unsupported key format')
    const parsed = parseKey(input.privateKey, passphrase)
    const { vaultId, privateKey } = input
    return this.insert({ vaultId, label, parsed, source: 'imported', privateKey, passphrase })
  }

  /** Imports the key at `path` (picked in main's file dialog), so its text never reaches the renderer. */
  async importFile(input: Omit<KeyImportInput, 'privateKey'>, path: string): Promise<SshKeyMeta> {
    this.vault.assertUnlocked()
    // Picked in the dialog, which may hand back a symlink.
    const privateKey = await readKeyFile(path, { follow: true })
    return this.import({ ...input, privateKey })
  }

  /** A new ed25519 key, commented `deps.defaultComment` unless the input names one. */
  generate(input: KeyGenerateInput): SshKeyMeta {
    this.vault.assertUnlocked()
    this.assertUsable(input.vaultId)
    const label = checkLabel(input.label)
    const comment = input.comment ?? this.defaultComment
    if (typeof comment !== 'string' || comment.length > MAX_KEY_COMMENT || CONTROL.test(comment)) {
      throw new Error(`key comment must be at most ${MAX_KEY_COMMENT} printable characters`)
    }
    const g = generateEd25519(comment)
    const parsed: ParsedKey = {
      keyType: 'ssh-ed25519',
      publicKey: g.publicKey.split(' ').slice(0, 2).join(' '),
      fingerprint: g.fingerprint,
      encrypted: false,
      comment,
    }
    return this.insert({ vaultId: input.vaultId, label, parsed, source: 'generated', privateKey: g.privateKey })
  }

  update(id: string, patch: { label?: string }): SshKeyMeta {
    this.vault.assertUnlocked()
    const before = this.row(id)
    this.assertUsable(before.vault_id)
    const label = patch.label === undefined ? before.label : checkLabel(patch.label)
    if (label === before.label) return toMeta(before)
    this.db
      .prepare('UPDATE ssh_keys SET label = ?, updated_at = ? WHERE id = ?')
      .run(label, new Date().toISOString(), id)
    this.audit.append({
      action: 'key.update',
      outcome: 'success',
      targetType: 'ssh_key',
      targetId: id,
      targetLabel: label,
      details: { fields: ['label'] },
    })
    return toMeta(this.row(id))
  }

  /** Refused while an identity uses the key. A linked key's file is left alone. */
  delete(id: string): void {
    this.vault.assertUnlocked()
    const before = this.row(id)
    this.assertUsable(before.vault_id)
    const user = this.db
      .prepare('SELECT label FROM identities WHERE ssh_key_id = ? ORDER BY label COLLATE NOCASE LIMIT 1')
      .get(id) as { label: string } | undefined
    if (user) throw new Error(`key is used by identity ${user.label}`)
    this.db.prepare('DELETE FROM ssh_keys WHERE id = ?').run(id)
    if (before.passphrase_enc !== null) this.refreshKnown()
    this.audit.append({
      action: 'key.delete',
      outcome: 'success',
      targetType: 'ssh_key',
      targetId: id,
      targetLabel: before.label,
      details: { keyType: before.key_type, source: before.source },
    })
  }

  /** Puts the public key line on the clipboard. Public, so not cleared and not audited (P7). */
  async copyPublic(id: string): Promise<void> {
    await this.clipboard.writeText(this.row(id).public_key)
  }

  /**
   * Main-process use only (Phase 4 connects with it): not audited and never exposed over IPC.
   * A linked key is read from disk now and must still be the key that was linked.
   */
  async material(id: string): Promise<{ privateKey: string; passphrase?: string }> {
    this.vault.assertUnlocked()
    let row = this.row(id)
    this.assertUsable(row.vault_id)
    const fileText = row.source === 'file' ? await this.readLinked(row.file_path!) : undefined
    // The vault may have locked, or the row changed, while the file was read.
    this.vault.assertUnlocked()
    row = this.row(id)
    this.assertUsable(row.vault_id)
    if (!this.loaded) this.refreshKnown()
    const passphrase =
      row.passphrase_enc === null ? undefined : this.vault.open(row.vault_id, passphraseAad(id), row.passphrase_enc)
    let privateKey: string
    if (fileText === undefined) {
      privateKey = this.vault.open(row.vault_id, privateAad(id), row.private_key_enc!)
    } else {
      let fingerprint: string
      try {
        fingerprint = parsePrivateKey(fileText, passphrase).fingerprint
      } catch {
        throw new Error('key file changed since it was linked')
      }
      if (fingerprint !== row.fingerprint) throw new Error('key file changed since it was linked')
      privateKey = fileText
    }
    return passphrase === undefined ? { privateKey } : { privateKey, passphrase }
  }

  /** Every decrypted passphrase, for redaction; [] while locked. Decrypts once per unlock. */
  knownValues(): readonly string[] {
    if (!this.vault.isUnlocked()) return []
    if (!this.loaded) this.refreshKnown()
    return this.vault.knownValues(KNOWN_SOURCE)
  }

  private insert(k: {
    vaultId: string
    label: string
    parsed: ParsedKey
    source: SshKeySource
    path?: string
    privateKey?: string
    passphrase?: string
  }): SshKeyMeta {
    const id = randomUUID()
    const privateEnc = k.privateKey === undefined ? null : this.vault.seal(k.vaultId, privateAad(id), k.privateKey)
    const passphraseEnc =
      k.passphrase === undefined ? null : this.vault.seal(k.vaultId, passphraseAad(id), k.passphrase)
    const ts = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO ssh_keys(id, vault_id, label, key_type, public_key, fingerprint, private_key_enc, passphrase_enc,
          source, file_path, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        k.vaultId,
        k.label,
        k.parsed.keyType,
        publicLine(k.parsed),
        k.parsed.fingerprint,
        privateEnc,
        passphraseEnc,
        k.source,
        k.path ?? null,
        ts,
        ts,
      )
    if (passphraseEnc !== null) this.refreshKnown()
    const action = k.source === 'file' ? 'key.link' : k.source === 'imported' ? 'key.import' : 'key.generate'
    this.audit.append({
      action,
      outcome: 'success',
      targetType: 'ssh_key',
      targetId: id,
      targetLabel: k.label,
      details: { keyType: k.parsed.keyType, encrypted: k.parsed.encrypted },
    })
    return toMeta(this.row(id))
  }

  /**
   * Type and fingerprint of a scanned key. An encrypted PEM key hides its public half, so it
   * comes from the `.pub` next to it.
   */
  private async identify(
    path: string,
    text: string,
  ): Promise<Pick<ParsedKey, 'keyType' | 'fingerprint' | 'encrypted'>> {
    try {
      return parsePrivateKey(text)
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'passphrase required') throw err
      // Directly in ~/.ssh by construction; a symlink is refused (lstat here, O_NOFOLLOW on open).
      const pubPath = `${path}.pub`
      if (!(await lstat(pubPath)).isFile()) throw err
      const pub = parsePublicKeyLine(await readKeyFile(pubPath, { follow: false }))
      return { keyType: pub.keyType, fingerprint: fingerprintOf(pub.blob), encrypted: true }
    }
  }

  /** Reads a linked key file, which must resolve (symlinks followed) inside ~/.ssh. */
  private async readLinked(path: string): Promise<string> {
    let real: string
    let root: string
    try {
      root = await realpath(this.sshDir)
      real = await realpath(path)
    } catch {
      throw new Error('cannot read key file')
    }
    if (!isInside(root, real)) throw new Error('key file is outside ~/.ssh')
    return readKeyFile(real, { follow: false })
  }

  /** Re-registers every readable passphrase; keys in corrupt vaults or failing to open are skipped. */
  private refreshKnown(): void {
    if (!this.vault.isUnlocked()) return
    const rows = this.db
      .prepare('SELECT id, vault_id, passphrase_enc FROM ssh_keys WHERE passphrase_enc IS NOT NULL')
      .all() as { id: string; vault_id: string; passphrase_enc: string }[]
    const values: string[] = []
    for (const r of rows) {
      if (this.vault.isCorrupt(r.vault_id)) continue
      try {
        values.push(this.vault.open(r.vault_id, passphraseAad(r.id), r.passphrase_enc))
      } catch {
        // Tampered or unreadable: material() reports it; there is nothing to redact.
      }
    }
    this.vault.registerKnown(KNOWN_SOURCE, values)
    this.loaded = true
  }

  private assertUsable(vaultId: string): void {
    if (!this.db.prepare('SELECT 1 FROM vaults WHERE id = ?').get(vaultId)) throw new Error('vault not found')
    if (this.vault.isCorrupt(vaultId)) throw new Error('vault key is corrupt')
  }

  private row(id: string): KeyRow {
    const row = this.db.prepare('SELECT * FROM ssh_keys WHERE id = ?').get(id) as KeyRow | undefined
    if (!row) throw new Error('ssh key not found')
    return row
  }
}
