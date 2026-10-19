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
    t.fixture('logs.err', 'warn four')
    const tail = await t.containers.logs(t.ids['app-1']!, null, 'web-1', 2)
    expect(t.dockerArgs()).toEqual(['logs', '--timestamps', '--tail', '2', 'web-1'])
    expect(tail.length).toBeLessThanOrEqual(12)
    expect(tail.endsWith('\n')).toBe(true)
    expect('line one\nline two\nline three\nwarn four\n'.endsWith(tail) || 'warn four\nline one\nline two\nline three\n'.endsWith(tail)).toBe(true)

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
