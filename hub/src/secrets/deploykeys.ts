import { generateEd25519 } from '../../../src/main/vault/openssh'
import { HubHttpError } from '../errors'
import type { HubDb } from '../db'
import type { KeyRing } from './keyring'

const aad = (environmentId: string): string => `hub-deploykey:v1:${environmentId}`

/** One ed25519 deploy key per environment. The private half is sealed at rest and has no read path but `privateForRun`. */
export class DeployKeys {
  constructor(
    private readonly db: HubDb,
    private readonly ring: KeyRing,
    private readonly opts: { now: () => Date },
  ) {}

  has(environmentId: string): boolean {
    return this.db.prepare('SELECT 1 FROM env_deploy_keys WHERE environment_id = ?').get(environmentId) !== undefined
  }

  /** Creates the key, or replaces it (rotation). */
  create(environmentId: string, environmentName: string): { publicKey: string; fingerprint: string } {
    const key = generateEd25519(`opsdeck-hub:${environmentName}`)
    this.db
      .prepare(
        `INSERT INTO env_deploy_keys(environment_id, public_key, fingerprint, private_enc, key_id, created_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(environment_id) DO UPDATE SET public_key = excluded.public_key, fingerprint = excluded.fingerprint,
           private_enc = excluded.private_enc, key_id = excluded.key_id, created_at = excluded.created_at`,
      )
      .run(environmentId, key.publicKey, key.fingerprint, this.ring.seal(key.privateKey, aad(environmentId)), this.ring.keyId, this.opts.now().toISOString())
    return { publicKey: key.publicKey, fingerprint: key.fingerprint }
  }

  publicKey(environmentId: string): { publicKey: string; fingerprint: string } | null {
    const r = this.db.prepare('SELECT public_key, fingerprint FROM env_deploy_keys WHERE environment_id = ?').get(environmentId) as
      | { public_key: string; fingerprint: string }
      | undefined
    return r ? { publicKey: r.public_key, fingerprint: r.fingerprint } : null
  }

  /** For the release runner only: the PEM, in memory. */
  privateForRun(environmentId: string): string {
    const r = this.db.prepare('SELECT private_enc FROM env_deploy_keys WHERE environment_id = ?').get(environmentId) as { private_enc: string } | undefined
    if (!r) throw new HubHttpError(409, 'conflict', 'This environment has no deploy key yet')
    try {
      return this.ring.open(r.private_enc, aad(environmentId))
    } catch {
      throw new Error('deploy key could not be decrypted')
    }
  }
}
