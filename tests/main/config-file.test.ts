import { describe, expect, it } from 'vitest'
import { buildConfigExport, serializeConfig } from '../../src/main/config/export'
import { CONFIG_MAX_BYTES, parseConfigFile, type ConfigFile } from '../../src/shared/config-file'
import { makeConfigFixture } from './config-helpers'

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

  it('accepts an empty config', () => {
    const empty: ConfigFile = {
      format: 'opsdeck-config',
      version: 1,
      exportedAt: '2026-10-20T10:00:00.000Z',
      secretRefs: {},
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
    expect(errorsOf(edit(file, (r) => (r.format = 'termius-export')))).toEqual(["This isn't an OpsDeck config file"])
    expect(errorsOf('[]')).toEqual(["This isn't an OpsDeck config file"])
    expect(errorsOf('null')).toEqual(["This isn't an OpsDeck config file"])
  })

  it('refuses version 2 with "This file is from a newer OpsDeck"', async () => {
    const file = await exported()
    expect(errorsOf(edit(file, (r) => (r.version = 2)))).toEqual(['This file is from a newer OpsDeck'])
    expect(errorsOf(edit(file, (r) => (r.version = '1')))).toEqual(['$.version is not a supported version'])
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

    const dangling = '0190a1b2-c3d4-4e5f-8a6b-999999999999'
    expect(errorsOf(edit(file, (r) => (r.hosts[host].jumpHostId = dangling)))).toEqual([`$.hosts[${host}].jumpHostId is not a host in this file`])
    expect(errorsOf(edit(file, (r) => (r.environments[0].productIds = [dangling])))).toEqual(['$.environments[0].productIds[0] is not a product in this file'])
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
    const text = '{"format": "opsdeck-config", "hosts": [{"address": "top-secret-host"'
    expect(errorsOf(text)).toEqual(["The file isn't valid JSON"])
    expect(errorsOf('hunter2')).toEqual(["The file isn't valid JSON"])
  })

  it('refuses a file over the size limit before parsing it', () => {
    expect(errorsOf(' '.repeat(CONFIG_MAX_BYTES + 1))).toEqual(['The file is larger than 5 MB'])
  })
})
