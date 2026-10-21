import { describe, expect, it, vi } from 'vitest'
import type { ReleaseRunMeta } from '../../src/main/deploy/finalize'
import type { Fetch } from '../../src/main/notify/http'
import { createQaHandlers } from '../../src/main/ipc/handlers/notify'
import { VALIDATORS } from '../../src/main/ipc/validators'
import { QaDispatcher, qaFinalizeStep } from '../../src/main/notify/qa'
import { IntegrationStore } from '../../src/main/settings/integration-store'
import { SettingsStore } from '../../src/main/settings/settings-store'
import { SecretStore } from '../../src/main/vault/secret-store'
import type { QaDispatch } from '../../src/shared/settings'
import { DEFAULT_VAULT_ID } from '../../src/shared/vault'
import { makeInventory, PRODUCT } from './inventory-helpers'
import { auditRows } from './vault-helpers'

const TOKEN = 'ghp_qaTokenValue1234567890abcdef'
const T0 = Date.parse('2026-10-19T12:00:00Z')
const API = 'https://api.github.com/repos/acme/shop-qa/actions'

type Route = (url: string, init: RequestInit) => Response | Promise<Response>
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function setup(route: Route = () => new Response(null, { status: 204 })) {
  const f = await makeInventory()
  const clipboard = { text: '', async writeText(t: string) { this.text = t }, async readText() { return this.text } }
  const secrets = new SecretStore(f.db, f.vault, f.audit, { clipboard })
  const settings = new SettingsStore({ db: f.db, audit: f.audit, vault: f.vault, secrets })
  const integrations = new IntegrationStore({ db: f.db, audit: f.audit, vault: f.vault, secrets })
  const token = secrets.create({ vaultId: DEFAULT_VAULT_ID, name: 'gh', kind: 'token', value: TOKEN })
  settings.update({ githubTokenSecretId: token.id })
  const env = f.envs.create({ productId: PRODUCT, name: 'staging', color: '#112233' })
  integrations.update(env.id, { qa: { repo: 'acme/shop-qa', workflow: 'qa.yml', ref: 'main' }, qaWait: true })
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return route(url, init)
  })
  const sleeps: number[] = []
  const clock = { t: T0 }
  const states: QaDispatch[] = []
  const notified: { conclusion: string | null; htmlUrl: string | null }[] = []
  const run = { releaseId: 'rel-1', environmentId: env.id, version: '1.2.0', options: { backup: true, notify: true, qa: true } } as unknown as ReleaseRunMeta
  const qa = new QaDispatcher({
    secrets,
    settings,
    integrations,
    fetch: fetch as unknown as Fetch,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock.t += ms
    },
    now: () => new Date(clock.t),
    audit: f.audit,
    dispatcher: { notifyQa: async (_r, conclusion, htmlUrl) => void notified.push({ conclusion, htmlUrl: htmlUrl ?? null }) as never },
    runs: { runMeta: () => run },
    knownSecrets: () => secrets.knownValues(),
  })
  qa.onState((d) => void states.push({ ...d }))
  return { f, secrets, settings, integrations, env, fetch, calls, sleeps, clock, states, notified, run, qa }
}

describe('QaDispatcher', () => {
  it('dispatches with ref, inputs and headers', async () => {
    const t = await setup()
    const d = await t.qa.dispatch(t.env.id, { trigger: 'manual', version: '1.2.0' })
    expect(t.calls).toHaveLength(1)
    const { url, init } = t.calls[0]!
    expect(url).toBe(`${API}/workflows/qa.yml/dispatches`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ ref: 'main', inputs: { environment: 'staging', version: '1.2.0' } })
    const h = new Headers(init.headers)
    expect(h.get('accept')).toBe('application/vnd.github+json')
    expect(h.get('x-github-api-version')).toBe('2022-11-28')
    expect(h.get('authorization')).toBe(`Bearer ${TOKEN}`)
    // The token is in that header and nowhere else.
    expect(url).not.toContain(TOKEN)
    expect(String(init.body)).not.toContain(TOKEN)
    expect(d).toMatchObject({ environmentId: t.env.id, releaseId: null, repo: 'acme/shop-qa', workflow: 'qa.yml', ref: 'main', state: 'dispatched', htmlUrl: null })
    expect(t.qa.list()).toEqual([d])
    expect(t.states.map((s) => s.state)).toEqual(['dispatched'])
    const ev = t.f.audit.list({ actions: ['qa.dispatch'] })
    expect(ev[0]).toMatchObject({ outcome: 'success', targetType: 'environment', targetId: t.env.id })
    expect(ev[0]!.details).toEqual({ trigger: 'manual', repo: 'acme/shop-qa', workflow: 'qa.yml', ref: 'main' })
    expect(auditRows(t.f.db)).not.toContain(TOKEN)
  })

  it('defaults qa off for prod-like environments', async () => {
    const t = await setup()
    const qa = { repo: 'acme/shop-qa', workflow: 'qa.yml', ref: 'main' }
    const product = t.f.products.create({ name: 'QA defaults', color: '#000000', icon: 'boxes' })
    for (const [name, on] of [['prod', false], ['UAT', false], ['uat_eu', false], ['staging', true]] as const) {
      const env = t.f.envs.create({ productId: product.id, name, color: '#000000' })
      t.integrations.update(env.id, { qa })
      expect(t.integrations.get(env.id).qaOnDeploy).toBe(on)
    }
  })

  it('skipped when run option off or no workflow', async () => {
    const t = await setup()
    const lines: string[] = []
    const step = qaFinalizeStep({ qa: t.qa, integrations: t.integrations })
    const ctx = (run: ReleaseRunMeta) => ({ run, log: (l: string) => void lines.push(l), signal: new AbortController().signal })
    await step(ctx({ ...t.run, options: { backup: true, notify: true, qa: false } }))
    const bare = t.f.envs.create({ productId: PRODUCT, name: 'dev', color: '#000000' })
    await step(ctx({ ...t.run, environmentId: bare.id }))
    expect(t.fetch).not.toHaveBeenCalled()
    expect(lines).toEqual(['QA: skipped (off for this run)', 'QA: skipped (no QA workflow)'])
    // On, with a workflow: dispatches and logs where.
    t.integrations.update(t.env.id, { qaWait: false })
    await step(ctx(t.run))
    expect(lines.at(-1)).toBe('QA: dispatched acme/shop-qa/qa.yml@main')
    expect(t.qa.list()[0]).toMatchObject({ releaseId: 'rel-1' })
  })

  it('wait finds the run and reports conclusion', async () => {
    let listed = 0
    let polled = 0
    const t = await setup((url) => {
      if (url.endsWith('/dispatches')) return new Response(null, { status: 204 })
      if (url.includes('/workflows/qa.yml/runs?')) {
        listed++
        const old = { id: 1, created_at: '2026-10-19T11:50:00Z', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/shop-qa/actions/runs/1' }
        const mine = { id: 2, created_at: '2026-10-19T12:00:20Z', status: 'queued', conclusion: null, html_url: 'https://github.com/acme/shop-qa/actions/runs/2' }
        return json({ workflow_runs: listed === 1 ? [old] : [mine, old] })
      }
      if (url === `${API}/runs/2`) {
        polled++
        return json({ id: 2, status: polled < 2 ? 'in_progress' : 'completed', conclusion: polled < 2 ? null : 'failure', html_url: 'https://github.com/acme/shop-qa/actions/runs/2' })
      }
      return new Response(null, { status: 404 })
    })
    const d = await t.qa.dispatch(t.env.id, { trigger: 'release', releaseId: 'rel-1' })
    const res = await t.qa.wait(d, new AbortController().signal)
    expect(res).toEqual({ conclusion: 'failure', htmlUrl: 'https://github.com/acme/shop-qa/actions/runs/2' })
    const listUrl = t.calls.find((c) => c.url.includes('/runs?'))!.url
    expect(listUrl).toBe(`${API}/workflows/qa.yml/runs?event=workflow_dispatch&branch=main&per_page=10`)
    expect(t.sleeps).toEqual([15_000, 30_000])
    expect(t.states.map((s) => s.state)).toEqual(['dispatched', 'running', 'failed'])
    expect(t.notified).toEqual([{ conclusion: 'failure', htmlUrl: 'https://github.com/acme/shop-qa/actions/runs/2' }])
    expect(t.f.audit.list({ actions: ['qa.finished'] })[0]!.details).toEqual({ conclusion: 'failure' })
  })

  const NEVER_DONE = (url: string): Response => {
    if (url.endsWith('/dispatches')) return new Response(null, { status: 204 })
    if (url.includes('/runs?')) return json({ workflow_runs: [{ id: 9, created_at: '2026-10-19T12:00:01Z', status: 'queued', conclusion: null, html_url: 'https://github.com/acme/shop-qa/actions/runs/9' }] })
    return json({ id: 9, status: 'in_progress', conclusion: null, html_url: 'https://github.com/acme/shop-qa/actions/runs/9' })
  }
  const polled = (sleeps: number[]): number => sleeps.filter((x) => x === 30_000).reduce((a, c) => a + c, 0)

  it('with no waitMinutes the wait polls up to 45 min, then gives up as unknown (row 46)', async () => {
    const t = await setup(NEVER_DONE)
    const d = await t.qa.dispatch(t.env.id, { trigger: 'release', releaseId: 'rel-1' })
    const res = await t.qa.wait(d, new AbortController().signal)
    expect(res.conclusion).toBeNull()
    expect(polled(t.sleeps)).toBe(45 * 60_000)
    expect(t.qa.list()[0]!.state).toBe('unknown')
    expect(t.notified).toEqual([])
  })

  it('waitMinutes: 10 stops polling at 10 min', async () => {
    const t = await setup(NEVER_DONE)
    t.integrations.update(t.env.id, { qa: { repo: 'acme/shop-qa', workflow: 'qa.yml', ref: 'main', waitMinutes: 10 } })
    const d = await t.qa.dispatch(t.env.id, { trigger: 'release', releaseId: 'rel-1' })
    expect(d.waitMinutes).toBe(10)
    await t.qa.wait(d, new AbortController().signal)
    expect(polled(t.sleeps)).toBe(10 * 60_000)
  })

  it('waitMinutes is validated 5..180 whole minutes, by the store and the IPC validator', async () => {
    const t = await setup()
    const qa = (waitMinutes: unknown) => ({ repo: 'acme/shop-qa', workflow: 'qa.yml', ref: 'main', waitMinutes }) as never
    for (const ok of [5, 45, 180]) expect(t.integrations.update(t.env.id, { qa: qa(ok) }).qa!.waitMinutes).toBe(ok)
    for (const bad of [4, 181, 0, -1, 10.5, '45', Number.NaN]) {
      expect(() => t.integrations.update(t.env.id, { qa: qa(bad) }), String(bad)).toThrow(/wait time/)
    }
    // unset again: the key disappears and the default applies
    expect(t.integrations.update(t.env.id, { qa: qa(undefined) }).qa).toEqual({ repo: 'acme/shop-qa', workflow: 'qa.yml', ref: 'main' })
    const v = VALIDATORS['integration:update']!
    const patch = (w: unknown) => [t.env.id, { qa: { repo: 'acme/shop-qa', workflow: 'qa.yml', ref: 'main', waitMinutes: w } }]
    expect(() => v(patch(10) as never)).not.toThrow()
    for (const bad of [4, 181, 1.5, 'x']) expect(() => v(patch(bad) as never), String(bad)).toThrow()
  })

  it('the wait never blocks the release: finalize starts it detached and returns', async () => {
    const t = await setup(NEVER_DONE)
    const watch = vi.fn(() => new Promise<void>(() => undefined)) // never settles
    const step = qaFinalizeStep({ qa: { dispatch: t.qa.dispatch.bind(t.qa), watch }, integrations: t.integrations })
    await step({ run: t.run, log: () => undefined, signal: new AbortController().signal })
    expect(watch).toHaveBeenCalledTimes(1)
  })

  it('a run that never appears is unknown after 2 min', async () => {
    const t = await setup((url) => (url.endsWith('/dispatches') ? new Response(null, { status: 204 }) : json({ workflow_runs: [] })))
    const d = await t.qa.dispatch(t.env.id, { trigger: 'manual' })
    await t.qa.wait(d, new AbortController().signal)
    expect(t.sleeps.reduce((a, b) => a + b, 0)).toBe(120_000)
    expect(t.qa.list()[0]!.state).toBe('unknown')
  })

  it('404 maps to "QA workflow not found (HTTP 404)"', async () => {
    const t = await setup(() => new Response(`not found ${TOKEN}`, { status: 404 }))
    await expect(t.qa.dispatch(t.env.id, { trigger: 'manual' })).rejects.toThrow(/^QA workflow not found \(HTTP 404\)$/)
    const ev = t.f.audit.list({ actions: ['qa.dispatch'] })
    expect(ev[0]).toMatchObject({ outcome: 'failure' })
    expect(auditRows(t.f.db)).not.toContain(TOKEN)
  })

  it('the token never appears in errors', async () => {
    const t = await setup(() => new Response(TOKEN, { status: 401 }))
    const e1 = await t.qa.dispatch(t.env.id, { trigger: 'manual' }).catch((e: Error) => e)
    expect((e1 as Error).message).toBe('GitHub rejected the token (HTTP 401)')
    const t2 = await setup(() => {
      throw new Error(`connect failed Bearer ${TOKEN}`)
    })
    const e2 = await t2.qa.dispatch(t2.env.id, { trigger: 'manual' }).catch((e: Error) => e)
    expect((e2 as Error).message).not.toContain(TOKEN)
    expect(auditRows(t2.f.db)).not.toContain(TOKEN)
    // No token set: a config error naming the setting.
    t.settings.update({ githubTokenSecretId: null })
    await expect(t.qa.dispatch(t.env.id, { trigger: 'manual' })).rejects.toThrow('No GitHub token set')
  })
})

describe('qa handlers', () => {
  it('a manual dispatch audits trigger manual and waits when qaWait is on', async () => {
    const t = await setup()
    const watch = vi.spyOn(t.qa, 'watch').mockImplementation(async () => undefined)
    const h = createQaHandlers({ qa: t.qa, integrations: t.integrations })
    const d = await h['qa:dispatch'](t.env.id)
    expect(watch).toHaveBeenCalledWith(d)
    expect(t.f.audit.list({ actions: ['qa.dispatch'] })[0]!.details).toMatchObject({ trigger: 'manual' })
    expect(await h['qa:list']()).toEqual([d])
    t.integrations.update(t.env.id, { qaWait: false })
    await h['qa:dispatch'](t.env.id)
    expect(watch).toHaveBeenCalledTimes(1)
  })

  it('validators reject a bad environment id', () => {
    expect(() => VALIDATORS['qa:dispatch'](['nope'])).toThrow()
    expect(VALIDATORS['qa:list']([])).toEqual([])
  })
})
