import { readFileSync, mkdirSync, statSync } from 'node:fs'
import { isIP } from 'node:net'
import { SESSION_TTL_HOURS } from '../../src/shared/hub'
import { EMAIL } from '../../src/shared/settings'

export interface HubConfig {
  name: string
  listen: { host: string; port: number }
  tls: { certFile: string; keyFile: string } | null
  publicUrl: string
  dataDir: string
  entra: { tenantId: string; clientId: string; redirectUri: string; authority: string; jwksUri: string }
  firstAdmin: { oid?: string; upn?: string }
  sessionTtlHours: number
  /** File holding the 32-byte base64 master key (mode 0600). The key itself is never in this JSON. */
  masterKeyFile?: string
  /** ansible-playbook to run releases with; found on PATH when not set. */
  ansibleBin?: string
  /** The From address on release emails; without it (or a SendGrid key) email is skipped. */
  sendgridFrom?: string
  /** Where release run dirs live (mode 0700); defaults to <dataDir>/runs. */
  runRoot?: string
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function fail(path: string, file: string, rule: string): never {
  throw new Error(`config: ${path} ${rule} (${file})`)
}

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h === '::1') return true
  return isIP(h) === 4 && h.startsWith('127.')
}

export function loadConfig(file: string): HubConfig {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`config: ${file} is not readable JSON`)
  }
  const bad = (path: string, rule: string): never => fail(path, file, rule)
  const obj = (v: unknown, path: string): Record<string, unknown> => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return bad(path, 'must be an object')
    return v as Record<string, unknown>
  }
  const str = (v: unknown, path: string): string => {
    if (typeof v !== 'string' || v.trim() === '') return bad(path, 'must be a non-empty string')
    return v
  }
  const url = (v: unknown, path: string, requireHttpsUnlessLoopback: boolean): string => {
    const s = str(v, path)
    let u: URL
    try {
      u = new URL(s)
    } catch {
      return bad(path, 'must be a URL')
    }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (!requireHttpsUnlessLoopback || isLoopback(u.hostname)))) {
      return bad(path, requireHttpsUnlessLoopback ? 'must be https (http only on loopback)' : 'must be http or https')
    }
    return s
  }

  const root = obj(raw, '$')
  const name = root.name === undefined ? 'OpsDeck Hub' : str(root.name, 'name')

  const listenIn = root.listen === undefined ? {} : obj(root.listen, 'listen')
  const host = listenIn.host === undefined ? '127.0.0.1' : str(listenIn.host, 'listen.host')
  const port = listenIn.port === undefined ? 8787 : listenIn.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) bad('listen.port', 'must be a port')

  let tls: HubConfig['tls'] = null
  if (root.tls !== null && root.tls !== undefined) {
    const t = obj(root.tls, 'tls')
    tls = { certFile: str(t.certFile, 'tls.certFile'), keyFile: str(t.keyFile, 'tls.keyFile') }
  }
  if (!isLoopback(host) && !tls) bad('tls', 'is required when listen.host is not loopback')

  const publicUrl = url(root.publicUrl, 'publicUrl', false)
  const dataDir = str(root.dataDir, 'dataDir')

  const e = obj(root.entra, 'entra')
  const tenantId = str(e.tenantId, 'entra.tenantId')
  if (!GUID.test(tenantId)) bad('entra.tenantId', 'must be a GUID')
  const clientId = str(e.clientId, 'entra.clientId')
  if (!GUID.test(clientId)) bad('entra.clientId', 'must be a GUID')
  const redirectUri = url(e.redirectUri, 'entra.redirectUri', false)
  const authority =
    e.authority === undefined
      ? `https://login.microsoftonline.com/${tenantId}/v2.0`
      : url(e.authority, 'entra.authority', true)
  const jwksUri =
    e.jwksUri === undefined
      ? `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`
      : url(e.jwksUri, 'entra.jwksUri', true)

  const fa = obj(root.firstAdmin, 'firstAdmin')
  const firstAdmin: HubConfig['firstAdmin'] = {}
  if (fa.oid !== undefined) firstAdmin.oid = str(fa.oid, 'firstAdmin.oid')
  if (fa.upn !== undefined) firstAdmin.upn = str(fa.upn, 'firstAdmin.upn')
  if (!firstAdmin.oid && !firstAdmin.upn) bad('firstAdmin', 'needs oid or upn')

  const ttl = root.sessionTtlHours === undefined ? SESSION_TTL_HOURS : root.sessionTtlHours
  if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 1 || ttl > 72) bad('sessionTtlHours', 'must be 1-72')

  let masterKeyFile = root.masterKeyFile === undefined ? undefined : str(root.masterKeyFile, 'masterKeyFile')
  if (masterKeyFile?.includes('${CREDENTIALS_DIRECTORY}')) {
    // systemd's LoadCredential= puts the key under this directory for the service only.
    const dir = process.env.CREDENTIALS_DIRECTORY
    if (!dir) bad('masterKeyFile', 'uses ${CREDENTIALS_DIRECTORY}, which is only set under systemd LoadCredential=')
    masterKeyFile = masterKeyFile.replaceAll('${CREDENTIALS_DIRECTORY}', () => dir as string)
  }
  if (root.masterKey !== undefined) bad('masterKey', 'is not allowed here; use masterKeyFile or OPSDECK_HUB_MASTER_KEY')

  const ansibleBin = root.ansibleBin === undefined ? undefined : str(root.ansibleBin, 'ansibleBin')
  if (ansibleBin !== undefined && !ansibleBin.startsWith('/')) bad('ansibleBin', 'must be an absolute path')
  const runRoot = root.runRoot === undefined ? undefined : str(root.runRoot, 'runRoot')
  if (runRoot !== undefined && !runRoot.startsWith('/')) bad('runRoot', 'must be an absolute path')

  const sendgridFrom = root.sendgridFrom === undefined ? undefined : str(root.sendgridFrom, 'sendgridFrom')
  if (sendgridFrom !== undefined && !EMAIL.test(sendgridFrom)) bad('sendgridFrom', 'must be an email address')

  return {
    name,
    listen: { host, port: port as number },
    tls,
    publicUrl,
    dataDir,
    entra: { tenantId, clientId, redirectUri, authority, jwksUri },
    firstAdmin,
    sessionTtlHours: ttl as number,
    ...(masterKeyFile ? { masterKeyFile } : {}),
    ...(ansibleBin ? { ansibleBin } : {}),
    ...(runRoot ? { runRoot } : {}),
    ...(sendgridFrom ? { sendgridFrom } : {}),
  }
}

/** Creates dataDir (0700) when missing; refuses a directory other users can read. */
export function checkDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if ((statSync(dir).mode & 0o077) !== 0) {
    throw new Error('dataDir must not be readable by other users (chmod 700)')
  }
}
