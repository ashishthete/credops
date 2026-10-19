import { execFile, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, symlinkSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFakeEntra, type FakeEntra } from '../../tests/main/fake-entra'
import { CLIENT, TENANT } from './helpers'

const here = dirname(fileURLToPath(import.meta.url))
const hubDir = resolve(here, '..')
const vite = resolve(hubDir, '../node_modules/.bin/vite')

let tmp: string
let bundle: string
let entra: FakeEntra
let binDir: string

// Async on purpose: the fake Entra lives in this process and must keep answering while the CLI runs.
const run = (args: string[], env: Record<string, string> = {}) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [bundle, ...args], { encoding: 'utf8', env: { PATH: binDir, ...env }, timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })
    })
  })

function writeConfig(name: string, over: Record<string, unknown> = {}, keyFile?: string): string {
  const dataDir = join(tmp, `data-${name}`)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  chmodSync(dataDir, 0o700)
  const file = join(tmp, `${name}.json`)
  writeFileSync(
    file,
    JSON.stringify({
      name: 'Test Hub',
      listen: { host: '127.0.0.1', port: 0 },
      publicUrl: 'http://127.0.0.1:8787',
      dataDir,
      entra: { tenantId: TENANT, clientId: CLIENT, redirectUri: 'http://127.0.0.1/callback', authority: entra.issuer, jwksUri: `${entra.issuer.replace('/v2.0', '')}/discovery/v2.0/keys` },
      firstAdmin: { upn: 'admin@example.com' },
      ...(keyFile ? { masterKeyFile: keyFile } : {}),
      ...over,
    }),
  )
  return file
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'opsdeck-hub-build-'))
  entra = await startFakeEntra({ tenantId: TENANT, clientId: CLIENT })
  binDir = join(tmp, 'bin')
  mkdirSync(binDir)
  for (const t of ['ansible-playbook', 'ssh-agent', 'ssh-add']) {
    writeFileSync(join(binDir, t), '#!/bin/sh\nexit 0\n')
    chmodSync(join(binDir, t), 0o755)
  }
  // The bundle keeps hub/package.json dependencies external, so it resolves them from a node_modules beside it.
  symlinkSync(join(hubDir, 'node_modules'), join(tmp, 'node_modules'))
  const out = join(tmp, 'dist')
  const r = spawnSync(vite, ['build', '--outDir', out, '--emptyOutDir'], { cwd: hubDir, encoding: 'utf8', timeout: 120_000 })
  expect(r.status, r.stdout + r.stderr).toBe(0)
  bundle = join(out, 'opsdeck-hub.mjs')
}, 150_000)

afterAll(async () => {
  await entra?.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('hub build and CLI', () => {
  it('builds one executable ESM file with a node shebang', async () => {
    expect(existsSync(bundle)).toBe(true)
    expect(readFileSync(bundle, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true)
  })

  it('prints usage and exits 2 on an unknown command', async () => {
    const r = await run(['nope'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('gen-master-key')
  })

  it('gen-master-key writes a 0600 key, prints no key, and refuses to overwrite', async () => {
    const keyFile = join(tmp, 'master.key')
    const a = await run(['gen-master-key', '--out', keyFile])
    expect(a.status, a.stderr).toBe(0)
    expect(statSync(keyFile).mode & 0o777).toBe(0o600)
    const key = readFileSync(keyFile, 'utf8').trim()
    expect(Buffer.from(key, 'base64')).toHaveLength(32)
    expect(a.stdout + a.stderr).not.toContain(key)
    const b = await run(['gen-master-key', '--out', keyFile])
    expect(b.status).toBe(1)
    expect(readFileSync(keyFile, 'utf8').trim()).toBe(key)
    expect(b.stdout + b.stderr).not.toContain(key)
  })

  it('check-config passes against fake Entra and prints no key bytes', async () => {
    const keyFile = join(tmp, 'ok.key')
    expect((await run(['gen-master-key', '--out', keyFile])).status).toBe(0)
    const key = readFileSync(keyFile, 'utf8').trim()
    const r = await run(['check-config', '--config', writeConfig('ok', {}, keyFile)])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toMatch(/ok\s+config/)
    expect(r.stdout).toMatch(/ok\s+master key/)
    expect(r.stdout).toMatch(/ok\s+Entra/)
    expect(r.stdout + r.stderr).not.toContain(key)
    expect(r.stdout + r.stderr).not.toContain(Buffer.from(key, 'base64').toString('hex'))
  })

  it('check-config fails on a missing tool, a loose key file, and an unreachable Entra', async () => {
    const keyFile = join(tmp, 'loose.key')
    expect((await run(['gen-master-key', '--out', keyFile])).status).toBe(0)
    const key = readFileSync(keyFile, 'utf8').trim()
    chmodSync(keyFile, 0o644)
    const cfg = writeConfig('bad', { entra: { tenantId: TENANT, clientId: CLIENT, redirectUri: 'http://127.0.0.1/callback', authority: 'http://127.0.0.1:1/x/v2.0' } }, keyFile)
    const r = await run(['check-config', '--config', cfg], { PATH: join(tmp, 'empty') })
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/FAIL\s+master key/)
    expect(r.stdout).toMatch(/FAIL\s+ansible-playbook/)
    expect(r.stdout).toMatch(/FAIL\s+Entra/)
    expect(r.stdout + r.stderr).not.toContain(key)
  })

  it('check-config rejects a dataDir other users can read', async () => {
    const keyFile = join(tmp, 'dd.key')
    expect((await run(['gen-master-key', '--out', keyFile])).status).toBe(0)
    const cfg = writeConfig('dd', {}, keyFile)
    chmodSync(JSON.parse(readFileSync(cfg, 'utf8')).dataDir, 0o755)
    const r = await run(['check-config', '--config', cfg])
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/FAIL\s+dataDir/)
  })
})
