import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

/** Parse level only: key=value lines per section. Nothing here runs systemd. */
function parse(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let section = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const head = /^\[(\w+)\]$/.exec(line)
    if (head) {
      section = head[1]!
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = `${section}.${line.slice(0, eq)}`
    out.set(key, [...(out.get(key) ?? []), line.slice(eq + 1)])
  }
  return out
}

describe('systemd unit', () => {
  const unit = parse(readFileSync(resolve(here, '../deploy/opsdeck-hub.service'), 'utf8'))
  const one = (k: string) => unit.get(k)?.[0]

  it('runs the built CLI as an unprivileged user', () => {
    expect(one('Service.User')).toBe('opsdeck-hub')
    expect(one('Service.ExecStart')).toMatch(/opsdeck-hub\.mjs serve --config \S+$/)
  })

  it('is hardened and writes only its data dir', () => {
    expect(one('Service.NoNewPrivileges')).toBe('true')
    expect(one('Service.ProtectSystem')).toBe('strict')
    expect(one('Service.ProtectHome')).toBe('true')
    expect(one('Service.PrivateTmp')).toBe('true')
    expect(one('Service.ReadWritePaths')).toBe('/var/lib/opsdeck-hub')
  })

  it('hands the master key over as a credential', () => {
    expect(one('Service.LoadCredential')).toBe('master-key:/etc/opsdeck-hub/master.key')
  })
})
