import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Client } from 'ssh2'
import type { AuditEvent } from '../../src/shared/audit'
import { MAX_LOG_FOLLOWS, type ContainerLogEvent } from '../../src/shared/ops'
import { VAULT_LOCKED } from '../../src/shared/vault'
import { ContainerService, type ContainerServiceDeps } from '../../src/main/ops/containers'
import type { Lease } from '../../src/main/ops/exec-links'
import { CONFIRM_MESSAGE } from '../../src/main/ops/protect'
import { shellWords } from './deploy-helpers'
import { makeRunSetup } from './ops-helpers'

const FULL_ID = (c: string): string => c.repeat(64)
const psLine = (o: Record<string, unknown>): string => JSON.stringify(o)

/** Three containers: two from compose project `shop` (one in the old `Status`-only shape), one plain. */
const PS_FIXTURE = [
  psLine({
    ID: FULL_ID('a'),
    Names: 'shop-web-1',
    Image: 'nginx:1.27',
    State: 'running',
    Status: 'Up 3 hours',
    Ports: '0.0.0.0:8080->80/tcp',
    CreatedAt: '2026-10-19 08:00:00 +0000 UTC',
    Labels: 'com.docker.compose.project=shop,com.docker.compose.service=web,note=a=b',
  }),
  'this is not json',
  psLine({
    ID: FULL_ID('b'),
    Names: 'shop-db-1',
    Image: 'postgres:16',
    Status: 'Up 2 days (Paused)',
    Ports: '',
    CreatedAt: '2026-10-17 08:00:00 +0000 UTC',
    Labels: 'com.docker.compose.service=db,com.docker.compose.project=shop',
  }),
  psLine({
    ID: FULL_ID('c'),
    Names: 'cron',
    Image: 'busybox',
    Status: 'Exited (0) 5 minutes ago',
    Ports: '',
    CreatedAt: '2026-10-18 08:00:00 +0000 UTC',
    Labels: '',
  }),
].join('\n')

async function setup(over: Partial<ContainerServiceDeps> = {}) {
  const t = await makeRunSetup()
  const logEvents: ContainerLogEvent[] = []
  const containers = new ContainerService({
    links: t.links,
    environments: () => t.envs.list(),
    hostLabel: (id) => {
      const h = t.hosts.list().find((x) => x.id === id)
      if (!h) throw new Error('host not found')
      return h.label
    },
    isLocked: () => !t.vault.isUnlocked(),
    audit: t.audit,
    emit: (_event, payload) => void logEvents.push(payload),
    ...over,
  })
  onTestFinished(() => containers.closeAll())
  const fixture = (name: string, text: string): void => writeFileSync(join(t.sh.fixtures, name), text)
  const dockerArgs = (): string[] => {
    try {
      return readFileSync(t.sh.dockerLog, 'utf8').split('\n').slice(0, -1)
    } catch {
      return []
    }
  }
  const resetArgs = (): void => writeFileSync(t.sh.dockerLog, '')
  // audit.list() is newest first.
  const containerRows = (): AuditEvent[] => t.audit.list().filter((e) => e.action.startsWith('container.')).reverse()
  const chunks = (followId: string): string =>
    logEvents.flatMap((e) => (e.followId === followId && 'chunk' in e ? [e.chunk] : [])).join('')
  const ends = (followId: string) => logEvents.filter((e) => e.followId === followId && 'ended' in e)
  return { ...t, containers, logEvents, fixture, dockerArgs, resetArgs, containerRows, chunks, ends }
}

describe('ContainerService', () => {
  it('lists containers from docker ps JSON lines with compose grouping', async () => {
    const t = await setup()
    t.fixture('ps.out', PS_FIXTURE)
    const list = await t.containers.list(t.ids['app-1']!, t.staging.id)
    expect(t.dockerArgs()).toEqual(['ps', '--all', '--no-trunc', '--format', '{{json .}}'])
    expect(list.skipped).toBe(1)
    expect(list.truncated).toBe(false)
    expect(Number.isNaN(Date.parse(list.fetchedAt))).toBe(false)
    expect(list.containers).toEqual([
      {
        id: FULL_ID('a'),
        name: 'shop-web-1',
        image: 'nginx:1.27',
        state: 'running',
        status: 'Up 3 hours',
        ports: '0.0.0.0:8080->80/tcp',
        createdAt: '2026-10-19 08:00:00 +0000 UTC',
        project: 'shop',
        service: 'web',
      },
      expect.objectContaining({ name: 'shop-db-1', state: 'paused', project: 'shop', service: 'db' }),
      expect.objectContaining({ name: 'cron', state: 'exited', project: null, service: null }),
    ])
    // Read-only: not audited.
    expect(t.containerRows()).toEqual([])
  })

  it('maps old docker Status shapes and skips lines that are not a container', async () => {
    const t = await setup()
    const line = (status: string, extra: Record<string, unknown> = {}): string =>
      psLine({ ID: FULL_ID('d'), Names: 'x', Image: 'i', Status: status, Ports: '', CreatedAt: '', Labels: '', ...extra })
    t.fixture(
      'ps.out',
      [
        line('Up 1 second'),
        line('Restarting (1) 2 seconds ago'),
        line('Created'),
        line('Dead'),
        line('', { State: 'removing' }),
        line('Up 1 second', { State: 'weird' }),
        line('Up', { Names: 'two,names' }),
        line('Up', { Names: '-flag' }),
        line('Up', { ID: 7 }),
        '[1,2]',
        '',
      ].join('\n'),
    )
    const list = await t.containers.list(t.ids['app-1']!, null)
    expect(list.containers.map((c) => [c.name, c.state])).toEqual([
      ['x', 'running'],
      ['x', 'restarting'],
      ['x', 'exited'],
      ['x', 'exited'],
      ['x', 'removing'],
      ['x', 'unknown'],
      ['two', 'running'],
    ])
    expect(list.skipped).toBe(3)
  })

  it('caps the list at MAX_CONTAINERS with a truncated flag', async () => {
    const t = await setup({ maxContainers: 2 })
    t.fixture('ps.out', PS_FIXTURE)
    const list = await t.containers.list(t.ids['app-1']!, null)
    expect(list.containers.map((c) => c.name)).toEqual(['shop-web-1', 'shop-db-1'])
    expect(list.truncated).toBe(true)
  })

  it('reports a missing docker and a socket permission error in plain words', async () => {
    const t = await setup()
    t.fixture('ps.err', 'sh: docker: command not found')
    t.fixture('ps.code', '127')
    await expect(t.containers.list(t.ids['app-1']!, null)).rejects.toThrow(/^Docker isn't installed on app-1$/)
    t.fixture(
      'ps.err',
      'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://x": dial unix',
    )
    t.fixture('ps.code', '1')
    await expect(t.containers.list(t.ids['app-1']!, null)).rejects.toThrow(
      /^Docker needs permission on app-1 \(add the user to the docker group\)$/,
    )
    t.fixture('ps.err', `Error: something else ${'x'.repeat(300)}\nsecond line`)
    const err = (await t.containers.list(t.ids['app-1']!, null).catch((e: Error) => e)) as Error
    expect(err.message.startsWith('Error: something else')).toBe(true)
    expect(err.message.length).toBeLessThanOrEqual(200)
    expect(err.message).not.toContain('second line')
  })

  it('start, stop and restart pass the ref as one argument', async () => {
    const t = await setup()
    for (const action of ['start', 'stop', 'restart'] as const) {
      t.resetArgs()
      await t.containers.action(t.ids['app-1']!, t.staging.id, 'web-1', action)
      expect(t.dockerArgs()).toEqual([action, 'web-1'])
    }
  })

  it('refuses a ref that is not a container name before anything runs', async () => {
    const t = await setup()
    const host = t.ids['app-1']!
    for (const ref of ['', '-h', '--help', 'web 1', 'web-1;x', 'web-1\n', '.hidden', 'a'.repeat(129)]) {
      await expect(t.containers.action(host, null, ref, 'stop')).rejects.toThrow(/^container must be a container name or id$/)
      await expect(t.containers.logs(host, null, ref, 10)).rejects.toThrow(/^container must be a container name or id$/)
      await expect(t.containers.follow(host, null, ref, 10)).rejects.toThrow(/^container must be a container name or id$/)
    }
    for (const tail of [-1, 1.5, Number.NaN, 5001]) {
      await expect(t.containers.logs(host, null, 'web-1', tail)).rejects.toThrow(/^tail must be a whole number from 0 to 5000$/)
    }
    await expect(t.containers.action(host, null, 'web-1', 'rm' as 'stop')).rejects.toThrow(/^action must be start, stop or restart$/)
    expect(t.server.execs()).toEqual([])
    expect(t.containerRows()).toEqual([])
  })

  it('stop in a protected environment needs the typed name', async () => {
    const t = await setup()
    const host = t.ids['prod-app-1']!
    for (const action of ['stop', 'restart'] as const) {
      await expect(t.containers.action(host, t.prod.id, 'web-1', action)).rejects.toThrow(CONFIRM_MESSAGE)
      await expect(t.containers.action(host, t.prod.id, 'web-1', action, 'Prod')).rejects.toThrow(CONFIRM_MESSAGE)
      await t.containers.action(host, t.prod.id, 'web-1', action, 'prod')
    }
    await t.containers.action(host, t.prod.id, 'web-1', 'start')
    expect(t.dockerArgs()).toEqual(['stop', 'web-1', 'restart', 'web-1', 'start', 'web-1'])
    const rows = t.containerRows()
    expect(rows.map((r) => [r.action, r.outcome])).toEqual([
      ['container.stop', 'denied'],
      ['container.stop', 'denied'],
      ['container.stop', 'success'],
      ['container.restart', 'denied'],
      ['container.restart', 'denied'],
      ['container.restart', 'success'],
      ['container.start', 'success'],
    ])
    expect(rows[0]).toMatchObject({ targetType: 'container', targetLabel: 'web-1@prod-app-1', details: { reason: 'confirm' } })
    expect(rows[2]!.details).toMatchObject({ confirmed: true })
  })

  it('container stop with environmentId null on a prod host needs the name', async () => {
    const t = await setup()
    const host = t.ids['prod-db-1']!
    await expect(t.containers.action(host, null, 'db', 'stop')).rejects.toThrow(CONFIRM_MESSAGE)
    await expect(t.containers.action(host, t.staging.id, 'db', 'stop')).rejects.toThrow(CONFIRM_MESSAGE)
    expect(t.dockerArgs()).toEqual([])
    await t.containers.action(host, null, 'db', 'stop', 'prod')
    expect(t.dockerArgs()).toEqual(['stop', 'db'])
    // A host outside any protected environment needs nothing.
    await t.containers.action(t.ids['app-2']!, null, 'db', 'stop')
  })

  it('an unknown environment is refused and audited as denied', async () => {
    const t = await setup()
    const missing = '0b7c9d2e-4f3a-4e1b-9c8d-7a6b5c4d3e2f'
    await expect(t.containers.action(t.ids['app-1']!, missing, 'web-1', 'start')).rejects.toThrow(/^environment not found$/)
    expect(t.dockerArgs()).toEqual([])
    expect(t.containerRows()).toEqual([
      expect.objectContaining({ action: 'container.start', outcome: 'denied', details: expect.objectContaining({ reason: 'environment' }) }),
    ])
  })

  it('audits an action on a full id by the container name from the last list', async () => {
    const t = await setup()
    t.fixture('ps.out', PS_FIXTURE)
    await t.containers.list(t.ids['app-1']!, t.staging.id)
    await t.containers.action(t.ids['app-1']!, t.staging.id, FULL_ID('a'), 'restart')
    // a full id this host never listed keeps the short id
    await t.containers.action(t.ids['app-1']!, t.staging.id, FULL_ID('e'), 'restart')
    const rows = t.containerRows()
    expect(rows[0]).toMatchObject({ targetLabel: 'shop-web-1@app-1', details: { containerId: 'a'.repeat(12) } })
    expect(rows[1]).toMatchObject({ targetLabel: `${'e'.repeat(12)}@app-1` })
  })

  it('audits actions by container@host label', async () => {
    const t = await setup()
    await t.containers.action(t.ids['app-1']!, t.staging.id, 'web-1', 'stop')
    await t.containers.action(t.ids['app-1']!, null, FULL_ID('e'), 'start')
    t.fixture('restart.err', 'Error response from daemon: No such container: web-1')
    t.fixture('restart.code', '1')
    await expect(t.containers.action(t.ids['app-1']!, t.staging.id, 'web-1', 'restart')).rejects.toThrow(
      /^Error response from daemon: No such container: web-1$/,
    )
    const rows = t.containerRows()
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      action: 'container.stop',
      outcome: 'success',
      targetType: 'container',
      targetLabel: 'web-1@app-1',
      details: { hostId: t.ids['app-1'], environmentId: t.staging.id },
    })
    expect(rows[1]).toMatchObject({
      action: 'container.start',
      targetLabel: `${'e'.repeat(12)}@app-1`,
      details: { hostId: t.ids['app-1'], environmentId: null, containerId: 'e'.repeat(12) },
    })
    expect(rows[2]).toMatchObject({ action: 'container.restart', outcome: 'failure', targetLabel: 'web-1@app-1' })
    const all = JSON.stringify(rows)
    expect(all).not.toContain('127.0.0.1')
    expect(all).not.toContain('No such container')
  })

  it('logs tail returns the last lines and follow streams until unfollow', async () => {
    const t = await setup({ outputCap: 12 })
    t.fixture('logs.out', 'line one\nline two\nline three')
    const tail = await t.containers.logs(t.ids['app-1']!, null, 'web-1', 2)
    expect(t.dockerArgs()).toEqual(['logs', '--timestamps', '--tail', '2', 'web-1'])
    // Exactly the last 12 chars of what docker wrote.
    expect(tail).toBe('\nline three\n')
    t.fixture('logs.err', 'warn four')

    t.resetArgs()
    const id = await t.containers.follow(t.ids['app-1']!, null, 'web-1', 50)
    await t.waitFor(() => expect(t.chunks(id)).toContain('line three\n'))
    await t.waitFor(() => expect(t.chunks(id)).toContain('warn four\n'))
    expect(t.dockerArgs()).toEqual(['logs', '--timestamps', '--tail', '50', '--follow', 'web-1'])
    expect(t.sh.running()).toBe(1)
    expect(t.ends(id)).toEqual([])

    t.containers.unfollow(id)
    expect(t.ends(id)).toEqual([{ followId: id, ended: true, error: null }])
    await t.waitFor(() => expect(t.sh.running()).toBe(0))
    t.containers.unfollow(id)
    await new Promise((r) => setTimeout(r, 100))
    expect(t.ends(id)).toHaveLength(1)
    expect(t.containerRows()).toEqual([])
  })

  it('unfollowAll ends every follow and still lets new ones start', async () => {
    const t = await setup()
    t.fixture('logs.out', 'x')
    const a = await t.containers.follow(t.ids['app-1']!, null, 'web-1', 10)
    const b = await t.containers.follow(t.ids['app-1']!, null, 'web-2', 10)
    t.containers.unfollowAll()
    expect(t.ends(a)).toEqual([{ followId: a, ended: true, error: null }])
    expect(t.ends(b)).toEqual([{ followId: b, ended: true, error: null }])
    await t.waitFor(() => expect(t.sh.running()).toBe(0))
    const c = await t.containers.follow(t.ids['app-1']!, null, 'web-1', 10)
    expect(c).not.toBe(a)
    t.containers.unfollow(c)
  })

  it('a vault lock ends every follow with the locked error', async () => {
    const t = await setup()
    t.fixture('logs.out', 'x')
    const a = await t.containers.follow(t.ids['app-1']!, null, 'web-1', 10)
    const b = await t.containers.follow(t.ids['app-1']!, null, 'web-2', 10)
    t.containers.vaultLocked()
    const locked = { code: 'locked', message: 'The vault was locked; follow the logs again after unlocking' }
    expect(t.ends(a)).toEqual([{ followId: a, ended: true, error: locked }])
    expect(t.ends(b)).toEqual([{ followId: b, ended: true, error: locked }])
    await t.waitFor(() => expect(t.sh.running()).toBe(0))
  })

  it("a failed logs or follow never reports the container's own stderr lines", async () => {
    const t = await setup()
    const host = t.ids['app-1']!
    const app = 'Error: SENTINEL app said token=abc\nwarn SENTINEL again'
    // Docker's own error comes last; only a line in docker's own shape is shown.
    t.fixture('logs.err', `${app}\nError response from daemon: container web-1 is restarting`)
    t.fixture('logs.code', '1')
    await expect(t.containers.logs(host, null, 'web-1', 10)).rejects.toThrow(
      /^Error response from daemon: container web-1 is restarting$/,
    )
    let id = await t.containers.follow(host, null, 'web-1', 10)
    await t.waitFor(() => expect(t.ends(id)).toHaveLength(1))
    expect(t.ends(id)[0]).toEqual({
      followId: id,
      ended: true,
      error: { code: 'unknown', message: 'Error response from daemon: container web-1 is restarting' },
    })
    // App lines alone, even ones that look like errors: only the exit code.
    t.fixture('logs.err', app)
    t.fixture('logs.code', '3')
    const err = (await t.containers.logs(host, null, 'web-1', 10).catch((e: Error) => e)) as Error
    expect(err.message).toBe('docker logs exited with code 3 on app-1')
    id = await t.containers.follow(host, null, 'web-1', 10)
    await t.waitFor(() => expect(t.ends(id)).toHaveLength(1))
    expect(t.ends(id)[0]).toMatchObject({ error: { message: 'docker logs exited with code 3 on app-1' } })
    // The lines still stream as log output; they just never become error text.
    expect(t.chunks(id)).toContain('SENTINEL')
    const errorText = JSON.stringify(t.logEvents.filter((e) => 'ended' in e))
    expect(errorText).not.toContain('SENTINEL')
  })

  it('a follow whose docker exits ends with its error', async () => {
    const t = await setup()
    t.fixture('logs.err', 'Error: No such container: gone')
    t.fixture('logs.code', '1')
    const id = await t.containers.follow(t.ids['app-1']!, null, 'gone', 10)
    await t.waitFor(() => expect(t.ends(id)).toHaveLength(1))
    expect(t.ends(id)[0]).toEqual({ followId: id, ended: true, error: { code: 'unknown', message: 'Error: No such container: gone' } })
  })

  it(`allows ${MAX_LOG_FOLLOWS} follows per host and keeps channels free for list and actions`, async () => {
    const t = await setup()
    t.fixture('ps.out', PS_FIXTURE)
    const host = t.ids['app-1']!
    const ids: string[] = []
    for (let i = 0; i < MAX_LOG_FOLLOWS; i++) ids.push(await t.containers.follow(host, null, `web-${i}`, 1))
    await expect(t.containers.follow(host, null, 'web-x', 1)).rejects.toThrow(
      new Error(`app-1 already has ${MAX_LOG_FOLLOWS} log follows open; stop one first`),
    )
    // The two channels left on the link serve list and actions at once.
    const [list] = await Promise.all([t.containers.list(host, null), t.containers.action(host, null, 'web-0', 'restart')])
    expect(list.containers).toHaveLength(3)
    // Another host has its own allowance.
    const other = await t.containers.follow(t.ids['app-2']!, null, 'web-0', 1)
    t.containers.unfollow(ids[0]!)
    ids.push(await t.containers.follow(host, null, 'web-y', 1))
    for (const id of [...ids, other]) t.containers.unfollow(id)
    await t.waitFor(() => expect(t.sh.running()).toBe(0))
  })

  it('a follow survives a vault lock; a new list while locked throws', async () => {
    const t = await setup()
    t.fixture('logs.out', 'before')
    const host = t.ids['app-1']!
    const id = await t.containers.follow(host, null, 'web-1', 10)
    await t.waitFor(() => expect(t.chunks(id)).toContain('before'))
    t.vault.lock('manual')
    await new Promise((r) => setTimeout(r, 200))
    expect(t.ends(id)).toEqual([])
    expect(t.sh.running()).toBe(1)

    await expect(t.containers.list(host, null)).rejects.toThrow(new Error(VAULT_LOCKED))
    await expect(t.containers.logs(host, null, 'web-1', 10)).rejects.toThrow(new Error(VAULT_LOCKED))
    await expect(t.containers.follow(host, null, 'web-1', 10)).rejects.toThrow(new Error(VAULT_LOCKED))
    await expect(t.containers.action(host, null, 'web-1', 'start')).rejects.toThrow(new Error(VAULT_LOCKED))
    expect(t.containerRows().map((r) => [r.action, r.outcome, r.details['reason']])).toEqual([['container.start', 'denied', 'locked']])

    t.containers.unfollow(id)
    await t.waitFor(() => expect(t.sh.running()).toBe(0))
  })

  it('vaultReset stops every follow and forgets the listed names; later calls still work', async () => {
    const t = await setup()
    const host = t.ids['app-1']!
    t.fixture('ps.out', PS_FIXTURE)
    await t.containers.list(host, t.staging.id)
    const id = await t.containers.follow(host, null, 'web-1', 10)
    await t.waitFor(() => expect(t.sh.running()).toBe(1))
    t.containers.vaultReset()
    expect(t.ends(id)).toHaveLength(1)
    await t.waitFor(() => expect(t.sh.running()).toBe(0))

    // Named by its short id: the name came from a list before the reset.
    await t.containers.action(host, t.staging.id, FULL_ID('a'), 'restart')
    expect(t.containerRows()[0]).toMatchObject({ targetLabel: `${'a'.repeat(12)}@app-1` })
    const again = await t.containers.follow(host, null, 'web-1', 10)
    await t.waitFor(() => expect(t.sh.running()).toBe(1))
    t.containers.unfollow(again)
    await t.waitFor(() => expect(t.sh.running()).toBe(0))
  })

  it('closeAll stops every follow and refuses later calls', async () => {
    const t = await setup()
    const id = await t.containers.follow(t.ids['app-1']!, null, 'web-1', 10)
    await t.waitFor(() => expect(t.sh.running()).toBe(1))
    t.containers.closeAll()
    await t.waitFor(() => expect(t.sh.running()).toBe(0))
    expect(t.ends(id)).toHaveLength(1)
    await expect(t.containers.list(t.ids['app-1']!, null)).rejects.toThrow(/^OpsDeck is quitting$/)
  })
})

/** A lease that never comes until its signal aborts, or a fake client that records each exec. */
function fakeLinks(client?: Partial<Client>) {
  const owners: string[] = []
  const released: number[] = []
  const links: ContainerServiceDeps['links'] = {
    lease: (_hostId, _envId, owner, signal) => {
      owners.push(owner.id)
      if (!client) {
        return new Promise<Lease>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
      }
      return Promise.resolve({
        client: client as Client,
        label: 'app-1',
        envVars: { OD_HOST: 'app-1' },
        release: () => void released.push(1),
      })
    },
  }
  return { links, owners, released }
}

function unitService(links: ContainerServiceDeps['links'], over: Partial<ContainerServiceDeps> = {}) {
  const audit: unknown[] = []
  const service = new ContainerService({
    links,
    environments: () => [],
    hostLabel: () => 'app-1',
    isLocked: () => false,
    audit: { append: (i) => void audit.push(i) },
    emit: () => {},
    ...over,
  })
  onTestFinished(() => service.closeAll())
  return { service, audit }
}

describe('ContainerService leases', () => {
  const HOST = '6f2c1a52-8c55-4a43-9f29-2a5d8e1f4b10'

  it('leases as containers:<hostId>, passes the lease env and releases once the exec is over', async () => {
    let seen: { command: string; env: unknown } | null = null
    const f = fakeLinks({
      exec: ((command: string, opts: { env?: unknown }, cb: (err: Error) => void) => {
        seen = { command, env: opts.env }
        cb(Object.assign(new Error('open failed'), { reason: 1 }))
      }) as unknown as Client['exec'],
    })
    const { service } = unitService(f.links)
    await expect(service.list(HOST, null)).rejects.toThrow(/^The host refused another session \(MaxSessions\)$/)
    expect(f.owners).toEqual([`containers:${HOST}`])
    expect(seen).toEqual({ command: "docker ps '--all' '--no-trunc' '--format' '{{json .}}'", env: { OD_HOST: 'app-1' } })
    expect(f.released).toEqual([1])
  })

  it('a list or action on a starved host times out waiting for its lease', async () => {
    vi.useFakeTimers()
    onTestFinished(() => void vi.useRealTimers())
    const f = fakeLinks()
    const { service, audit } = unitService(f.links, { leaseTimeoutMs: 1000 })
    const list = service.list(HOST, null).catch((e: Error) => e)
    const action = service.action(HOST, null, 'web-1', 'start').catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(1000)
    expect(((await list) as Error).message).toBe('Timed out waiting for a connection to app-1')
    expect(((await action) as Error).message).toBe('Timed out waiting for a connection to app-1')
    expect(audit).toEqual([expect.objectContaining({ action: 'container.start', outcome: 'failure' })])
  })
})

/** A channel the test drives by hand: data, stderr, exit and close. */
class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter()
  readonly signals: string[] = []
  readonly writes: string[] = []
  private closed = false
  signal(name: string): void {
    this.signals.push(name)
  }
  write(d: unknown): boolean {
    this.writes.push(String(d))
    return true
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
  /** docker exits with `code`, then the channel closes. */
  end(code: number): void {
    this.emit('exit', code)
    this.close()
  }
}

function channelClient() {
  const execs: { command: string; env: unknown; ch: FakeChannel }[] = []
  const client = {
    exec: ((command: string, opts: { env?: unknown }, cb: (err: Error | undefined, ch: FakeChannel) => void) => {
      const ch = new FakeChannel()
      execs.push({ command, env: opts.env, ch })
      cb(undefined, ch)
    }) as unknown as Client['exec'],
  }
  return { client, execs }
}

describe('ContainerService.followCompose', () => {
  const HOST = '6f2c1a52-8c55-4a43-9f29-2a5d8e1f4b10'
  const ENV = '0190a1b2-c3d4-7e5f-8a6b-1234567890ab'
  const SPEC = { repoPath: '/srv/app', composeFile: 'deploy/compose.yml', composeProject: null, composeService: 'web', useSudo: 'no' as const }

  function composeRig(over: Partial<ContainerServiceDeps> = {}) {
    const c = channelClient()
    const f = fakeLinks(c.client)
    const events: ContainerLogEvent[] = []
    const { service, audit } = unitService(f.links, { emit: (_e, p) => void events.push(p), ...over })
    const ends = (id: string) => events.filter((e) => e.followId === id && 'ended' in e)
    const chunks = (id: string): string => events.flatMap((e) => (e.followId === id && 'chunk' in e ? [e.chunk] : [])).join('')
    return { ...c, ...f, service, audit, events, ends, chunks }
  }

  it('followCompose runs cd + compose logs -f --tail n svc with -p only when set', async () => {
    const r = composeRig()
    await r.service.followCompose(HOST, ENV, SPEC, 50)
    await r.service.followCompose(HOST, ENV, { ...SPEC, composeProject: 'shop', composeService: 'api.v2' }, 0)
    expect(shellWords(r.execs[0]!.command)).toEqual(['cd', '/srv/app', '&&', 'docker', 'compose', '-f', 'deploy/compose.yml', 'logs', '-f', '--tail', '50', 'web'])
    expect(shellWords(r.execs[1]!.command)).toEqual([
      'cd', '/srv/app', '&&', 'docker', 'compose', '-f', 'deploy/compose.yml', '-p', 'shop', 'logs', '-f', '--tail', '0', 'api.v2',
    ])
    // Same lease owner and env as any container follow; logs are never audited.
    expect(r.owners).toEqual([`containers:${HOST}`, `containers:${HOST}`])
    expect(r.execs[0]!.env).toEqual({ OD_HOST: 'app-1' })
    expect(r.audit).toEqual([])
  })

  it('followCompose uses sudo -n for yes, plain for no, the docker-info switch for auto', async () => {
    const r = composeRig({ maxFollows: 3 })
    await r.service.followCompose(HOST, ENV, { ...SPEC, useSudo: 'yes' }, 10)
    await r.service.followCompose(HOST, ENV, { ...SPEC, useSudo: 'no' }, 10)
    await r.service.followCompose(HOST, ENV, { ...SPEC, useSudo: 'auto' }, 10)
    const tail = ['compose', '-f', 'deploy/compose.yml', 'logs', '-f', '--tail', '10', 'web']
    const [yes, no, auto] = r.execs.map((e) => shellWords(e.command))
    expect(yes).toEqual(['cd', '/srv/app', '&&', 'sudo', '-n', 'docker', ...tail])
    expect(no).toEqual(['cd', '/srv/app', '&&', 'docker', ...tail])
    const run = auto!.indexOf('$D')
    expect(auto!.slice(0, run)).toEqual([
      'cd', '/srv/app', '&&', 'if', 'docker', 'info', '>/dev/null', '2>&1', ';', 'then', 'D=docker', ';', 'else', 'D=sudo -n docker', ';', 'fi', '&&',
    ])
    expect(auto!.slice(run + 1)).toEqual(tail)
  })

  it('followCompose refuses a bad repo path, compose file, project or service', async () => {
    const r = composeRig()
    const bad: [Record<string, unknown>, string][] = [
      [{ repoPath: 'srv/app' }, 'invalid repo path'],
      [{ repoPath: '/srv/../etc' }, 'invalid repo path'],
      [{ repoPath: '/srv/app; rm -rf /' }, 'invalid repo path'],
      [{ composeFile: '-f' }, 'invalid compose file'],
      [{ composeFile: '/etc/compose.yml' }, 'invalid compose file'],
      [{ composeProject: '-p' }, 'invalid compose project'],
      [{ composeService: 'web svc' }, 'invalid compose service'],
      [{ composeService: '$(id)' }, 'invalid compose service'],
      [{ useSudo: 'always' }, 'useSudo must be auto, yes or no'],
    ]
    for (const [over, message] of bad) {
      await expect(r.service.followCompose(HOST, ENV, { ...SPEC, ...over } as never, 10), JSON.stringify(over)).rejects.toThrow(new Error(message))
    }
    await expect(r.service.followCompose(HOST, ENV, SPEC, -1)).rejects.toThrow(/^tail must be a whole number/)
    expect(r.owners).toEqual([])
    expect(r.execs).toEqual([])
  })

  it('followCompose counts toward maxFollows and emits containers:logs', async () => {
    const r = composeRig({ maxFollows: 2 })
    const a = await r.service.followCompose(HOST, ENV, SPEC, 10)
    const b = await r.service.follow(HOST, ENV, 'web-1', 10)
    const full = new Error('app-1 already has 2 log follows open; stop one first')
    await expect(r.service.followCompose(HOST, ENV, SPEC, 10)).rejects.toThrow(full)
    await expect(r.service.follow(HOST, ENV, 'web-2', 10)).rejects.toThrow(full)

    r.execs[0]!.ch.emit('data', Buffer.from('web-1  | GET / 200\n'))
    await vi.waitFor(() => expect(r.chunks(a)).toBe('web-1  | GET / 200\n'))
    r.execs[0]!.ch.end(0)
    await vi.waitFor(() => expect(r.ends(a)).toEqual([{ followId: a, ended: true, error: null }]))
    // An ended follow frees its slot.
    const c = await r.service.followCompose(HOST, ENV, SPEC, 10)
    r.service.unfollow(c)
    r.service.unfollow(b)
    expect(r.ends(c)).toEqual([{ followId: c, ended: true, error: null }])
    expect(r.audit).toEqual([])
  })

  it('a docker permission error ends the follow with the sudo hint', async () => {
    const r = composeRig({ maxFollows: 4 })
    const hint = { code: 'unknown', message: "Docker on app-1 needs sudo for logs; check the checkout's sudo setting" }
    const stderr = [
      'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/containers/json": dial unix /var/run/docker.sock: connect: permission denied',
      'sudo: a password is required',
      'sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper',
    ]
    for (const [i, line] of stderr.entries()) {
      const id = await r.service.followCompose(HOST, ENV, { ...SPEC, useSudo: i === 0 ? 'no' : 'yes' }, 10)
      r.execs[i]!.ch.stderr.emit('data', Buffer.from(`${line}\n`))
      r.execs[i]!.ch.end(1)
      await vi.waitFor(() => expect(r.ends(id)).toEqual([{ followId: id, ended: true, error: hint }]))
    }
    // Any other failure keeps the logs error.
    const id = await r.service.followCompose(HOST, ENV, SPEC, 10)
    r.execs[3]!.ch.stderr.emit('data', Buffer.from('no such service: web\n'))
    r.execs[3]!.ch.end(1)
    await vi.waitFor(() => expect(r.ends(id)).toEqual([{ followId: id, ended: true, error: { code: 'unknown', message: 'docker logs exited with code 1 on app-1' } }]))
  })

  it('a vault lock ends a compose follow too', async () => {
    const r = composeRig()
    const id = await r.service.followCompose(HOST, ENV, SPEC, 10)
    r.service.vaultLocked()
    expect(r.ends(id)).toEqual([{ followId: id, ended: true, error: { code: 'locked', message: 'The vault was locked; follow the logs again after unlocking' } }])
  })

  it('followCompose never asks for a secret', async () => {
    const asked: string[] = []
    // A tripwire: ContainerService has no secrets dep today, so this only fires if one is added and used.
    const secrets = new Proxy({}, { get: (_t, k) => (asked.push(String(k)), () => { throw new Error('a secret was asked for') }) })
    const r = composeRig({ ...({ secrets } as object), maxFollows: 3 })
    for (const useSudo of ['yes', 'no', 'auto'] as const) await r.service.followCompose(HOST, ENV, { ...SPEC, useSudo }, 10)
    for (const e of r.execs) {
      // No password on stdin and no `sudo -S`: sudo only ever runs non-interactive.
      expect(e.ch.writes).toEqual([])
      expect(shellWords(e.command)).not.toContain('-S')
      expect(e.env).toEqual({ OD_HOST: 'app-1' })
    }
    expect(asked).toEqual([])
  })
})
