import { describe, expect, it } from 'vitest'
import { buildConfigExport, serializeConfig } from '../../src/main/config/export'
import { CONFIG_MAX_BYTES, parseConfigFile, type ConfigFile } from '../../src/shared/config-file'
import { makeConfigFixture } from './config-helpers'
import { REGION } from './inventory-helpers'

const clock = () => new Date('2026-10-20T10:00:00.000Z')

async function exported(): Promise<ConfigFile> {
  const f = await makeConfigFixture()
  return buildConfigExport(f.db, clock).file
}

/** A deep copy to break, re-serialized the way a hand-edited file would be. */
function edit(file: ConfigFile, fn: (raw: any) => void): string {
  const raw = JSON.parse(JSON.stringify(file))
  fn(raw)
  return JSON.stringify(raw, null, 2)
}

/** The file written the way version 1 wrote it: no regions, and product links as a list. */
function v1(file: ConfigFile, fn: (raw: any) => void = () => {}): string {
  return edit(file, (r) => {
    r.version = 1
    delete r.regions
    for (const h of r.hosts) delete h.regionId
    for (const e of r.environments) {
      e.productIds = [e.productId]
      delete e.productId
    }
    fn(r)
  })
}

function errorsOf(text: string): string[] {
  const res = parseConfigFile(text)
  if (res.ok) throw new Error('expected the file to be refused')
  return res.errors
}

describe('parseConfigFile', () => {
  it('parseConfigFile accepts an exported file', async () => {
    const file = await exported()
    expect(parseConfigFile(serializeConfig(file))).toEqual({ ok: true, file })
  })

  it('reads a file exported before the rename, as OpsDeck', async () => {
    const file = await exported()
    const old = serializeConfig({ ...file, format: 'opsdeck-config' as typeof file.format })
    expect(parseConfigFile(old)).toEqual({ ok: true, file })
  })

  it('accepts an empty config', () => {
    const empty: ConfigFile = {
      format: 'credops-config',
      version: 2,
      exportedAt: '2026-10-20T10:00:00.000Z',
      secretRefs: {},
      regions: [],
      products: [],
      identities: [],
      hosts: [],
      environments: [],
      tunnels: [],
      deployments: [],
      services: [],
    }
    expect(parseConfigFile(serializeConfig(empty))).toEqual({ ok: true, file: empty })
  })

  it('refuses an unknown format', async () => {
    const file = await exported()
    expect(errorsOf(edit(file, (r) => (r.format = 'termius-export')))).toEqual(["This isn't a CredOps config file"])
    expect(errorsOf('[]')).toEqual(["This isn't a CredOps config file"])
    expect(errorsOf('null')).toEqual(["This isn't a CredOps config file"])
  })

  it('refuses version 3 with "This file is from a newer CredOps"', async () => {
    const file = await exported()
    expect(errorsOf(edit(file, (r) => (r.version = 3)))).toEqual(['This file is from a newer CredOps'])
    expect(errorsOf(edit(file, (r) => (r.version = '2')))).toEqual(['$.version is not a supported version'])
  })

  it('exports regions, host regions and one product per environment', async () => {
    const file = await exported()
    expect(file.version).toBe(2)
    expect(file.regions).toEqual([{ id: REGION, code: 'test-1', provider: '', displayName: 'Test' }])
    expect(file.hosts.every((h) => h.regionId === REGION)).toBe(true)
    expect(file.environments.map((e) => e.productId)).not.toContain(null)
    expect(file.fromV1).toBeUndefined()
  })

  it('reads a version 1 file: hosts without a region, each environment in the product whose name sorts first', async () => {
    const file = await exported()
    const a = '0190a1b2-c3d4-4e5f-8a6b-00000000000a'
    const b = '0190a1b2-c3d4-4e5f-8a6b-00000000000b'
    const text = v1(file, (r) => {
      r.products.push({ ...r.products[0], id: b, name: 'alpha' }, { ...r.products[0], id: a, name: 'Alpha' })
      r.environments[0].productIds = [r.products[0].id, b, a]
      for (const e of r.environments.slice(1)) e.productIds = []
    })
    const res = parseConfigFile(text)
    if (!res.ok) throw new Error(res.errors.join('\n'))
    expect(res.file.version).toBe(2)
    expect(res.file.regions).toEqual([])
    expect(res.file.hosts.map((h) => h.regionId)).toEqual(file.hosts.map(() => null))
    // 'alpha' and 'Alpha' tie on the lowercased name; the smaller id wins.
    expect(res.file.environments[0]!.productId).toBe(a)
    expect(res.file.environments.slice(1).map((e) => e.productId)).toEqual(file.environments.slice(1).map(() => null))
    expect(res.file.fromV1!.productIds[file.environments[0]!.id]).toEqual([file.products[0]!.id, b, a])
    // Version 1 shapes only: a region field, or a v2 productId, is refused.
    expect(errorsOf(v1(file, (r) => (r.hosts[0].regionId = REGION)))).toEqual(['$.hosts[0].regionId is not an allowed key'])
    expect(errorsOf(v1(file, (r) => (r.regions = [])))).toEqual(['$.regions is not an allowed key'])
    const dangling = '0190a1b2-c3d4-4e5f-8a6b-999999999999'
    expect(errorsOf(v1(file, (r) => (r.environments[0].productIds = [dangling])))).toEqual(['$.environments[0].productIds[0] is not a product in this file'])
  })

  it('refuses unknown keys, wrong types and dangling ids with a JSON path and no value', async () => {
    const file = await exported()
    const host = file.hosts.findIndex((h) => h.label === 'app1')

    expect(errorsOf(edit(file, (r) => (r.extra = 1)))).toEqual(['$.extra is not an allowed key'])
    expect(errorsOf(edit(file, (r) => (r.hosts[host].sshPassword = 'hunter2')))).toEqual([`$.hosts[${host}].sshPassword is not an allowed key`])
    expect(errorsOf(edit(file, (r) => (r.deployments[0].urls[0].extra = true)))).toEqual(['$.deployments[0].urls[0].extra is not an allowed key'])
    expect(errorsOf(edit(file, (r) => delete r.products[0].color))).toEqual(['$.products[0].color is required'])
    expect(errorsOf(edit(file, (r) => (r.hosts[host].port = '22')))).toEqual([`$.hosts[${host}].port must be an integer`])
    expect(errorsOf(edit(file, (r) => (r.tunnels[0].autoStart = 'yes')))).toEqual(['$.tunnels[0].autoStart must be a boolean'])
    expect(errorsOf(edit(file, (r) => (r.products = {})))).toEqual(['$.products must be an array'])

    // A bad address: the path and the rule, never the address itself.
    const badAddress = 'evil host; rm -rf /'
    const [addressError] = errorsOf(edit(file, (r) => (r.hosts[host].address = badAddress)))
    expect(addressError).toBe(`$.hosts[${host}].address has an invalid format`)
    expect(addressError).not.toContain('evil')

    const deploy = errorsOf(edit(file, (r) => (r.deployments[0].repoPath = 'relative/path')))
    expect(deploy).toEqual(['$.deployments[0].repoPath has an invalid format'])
    expect(errorsOf(edit(file, (r) => (r.deployments[0].defaultBranch = '--upload-pack=x')))).toEqual(['$.deployments[0].defaultBranch has an invalid format'])
    expect(errorsOf(edit(file, (r) => (r.deployments[0].urls[0].url = 'ftp://x.example')))).toEqual(['$.deployments[0].urls[0].url must be an http(s) URL without credentials'])
    // Credentials in a repo URL: refused, and the message carries the path only.
    const cred = errorsOf(edit(file, (r) => (r.products[0].repoUrl = 'https://u:SECRETVAL@host/x.git')))
    expect(cred).toEqual(['$.products[0].repoUrl must not carry credentials'])
    expect(errorsOf(edit(file, (r) => (r.deployments[0].repoUrl = 'ssh://git:SECRETVAL@host/x.git')))).toEqual(['$.deployments[0].repoUrl must not carry credentials'])
    expect(errorsOf(edit(file, (r) => (r.deployments[0].repoUrl = 'https://tok@host/x.git')))).toEqual(['$.deployments[0].repoUrl must not carry credentials'])
    // Extra slashes and backslashes can't hide credentials.
    for (const u of ['https:///tok:pw@host/x.git', 'https:////tok@host/x', 'HTTPS://tok@host/x', 'https:\\\\tok:pw@host/x']) {
      expect(parseConfigFile(edit(file, (r) => (r.deployments[0].repoUrl = u))).ok, u).toBe(false)
    }
    // An ssh user is fine.
    expect(parseConfigFile(edit(file, (r) => (r.deployments[0].repoUrl = 'ssh://git@host/x.git'))).ok).toBe(true)
    expect(parseConfigFile(edit(file, (r) => (r.deployments[0].repoUrl = 'git@host:x.git'))).ok).toBe(true)

    const dangling = '0190a1b2-c3d4-4e5f-8a6b-999999999999'
    expect(errorsOf(edit(file, (r) => (r.hosts[host].jumpHostId = dangling)))).toEqual([`$.hosts[${host}].jumpHostId is not a host in this file`])
    expect(errorsOf(edit(file, (r) => (r.environments[0].productId = dangling)))).toEqual(['$.environments[0].productId is not a product in this file'])
    expect(errorsOf(edit(file, (r) => (r.environments[0].productId = null)))).toEqual(['$.environments[0].productId must be a uuid'])
    expect(errorsOf(edit(file, (r) => (r.hosts[host].regionId = dangling)))).toEqual([`$.hosts[${host}].regionId is not a region in this file`])
    expect(errorsOf(edit(file, (r) => delete r.hosts[host].regionId))).toEqual([`$.hosts[${host}].regionId is required`])
    expect(errorsOf(edit(file, (r) => (r.regions[0].code = 'EU West')))).toEqual(['$.regions[0].code has an invalid format'])
    expect(errorsOf(edit(file, (r) => (r.deployments[0].becomeSecret = 'ref-99')))).toEqual(['$.deployments[0].becomeSecret is not a secret ref in this file'])
    expect(errorsOf(edit(file, (r) => (r.deployments[0].envTemplate = 'X=${secret:ref-42}\n')))).toEqual([
      '$.deployments[0].envTemplate refers to a secret ref not in this file',
    ])
    expect(errorsOf(edit(file, (r) => (r.services[0].environmentId = dangling)))).toEqual(['$.services[0].environmentId is not an environment in this file'])
    expect(errorsOf(edit(file, (r) => r.hosts.push({ ...r.hosts[host] })))).toContain(`$.hosts[${file.hosts.length}].id is a duplicate id`)

    // Errors never carry a value from the file.
    const all = errorsOf(
      edit(file, (r) => {
        r.hosts[host].label = ''
        r.hosts[host].notes = 7
        r.products[0].name = 'x'.repeat(65)
        r.deployments[0].envTemplate = 'API_TOKEN=plain-token-value\n'
      }),
    )
    expect(all).toEqual([
      '$.products[0].name must be 1-64 characters',
      `$.hosts[${host}].label must be 1-120 characters`,
      `$.hosts[${host}].notes must be a string`,
      '$.deployments[0].envTemplate line 1: API_TOKEN looks sensitive; use a vault secret',
    ])
    expect(all.join('\n')).not.toContain('plain-token-value')
  })

  it('refuses invalid JSON without echoing the text', () => {
    const text = '{"format": "credops-config", "hosts": [{"address": "top-secret-host"'
    expect(errorsOf(text)).toEqual(["The file isn't valid JSON"])
    expect(errorsOf('hunter2')).toEqual(["The file isn't valid JSON"])
  })

  it('refuses a file over the size limit before parsing it', () => {
    expect(errorsOf(' '.repeat(CONFIG_MAX_BYTES + 1))).toEqual(['The file is larger than 5 MB'])
  })
})
