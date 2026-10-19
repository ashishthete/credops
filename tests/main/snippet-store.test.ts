import { describe, expect, it } from 'vitest'
import { createOpsHandlers } from '../../src/main/ipc/handlers/ops'
import { SnippetStore } from '../../src/main/ops/snippet-store'
import { MAX_SCRIPT, MAX_SNIPPET_DESCRIPTION, MAX_SNIPPETS, type SnippetInput } from '../../src/shared/ops'
import { auditRows } from './vault-helpers'
import { makeInventory } from './inventory-helpers'

async function setup() {
  const f = await makeInventory()
  const store = new SnippetStore({ db: f.db, audit: f.audit, vault: f.vault })
  const input = (over: Partial<SnippetInput> = {}): SnippetInput => ({
    label: 'status',
    script: 'systemctl status {{unit}}',
    ...over,
  })
  const events = (action: string) => f.audit.list({ actions: [action as never] })
  return { f, store, input, events }
}

function message(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('did not throw')
}

describe('SnippetStore', () => {
  it('creates a snippet with derived variables, sorted tags and defaults', async () => {
    const { store, input } = await setup()
    const s = store.create(input({ tags: ['Ops', 'ops', 'svc'], description: '  checks a unit ', defaults: { unit: 'nginx' } }))
    expect(s).toMatchObject({
      label: 'status',
      script: 'systemctl status {{unit}}',
      description: 'checks a unit',
      tags: ['ops', 'svc'],
      variables: [{ name: 'unit', default: 'nginx' }],
      destructive: false,
    })
    const plain = store.create(input({ label: 'plain', tags: ['Ops', 'ops', 'svc'] }))
    expect(plain.tags).toEqual(['ops', 'svc'])
    expect(plain.variables).toEqual([{ name: 'unit', default: null }])
    expect(store.list().map((x) => x.label)).toEqual(['plain', 'status'])
    expect(store.get(s.id)).toEqual(s)
  })

  it('drops defaults for names the script does not use, and checks default values', async () => {
    const { f, store, input } = await setup()
    const s = store.create(input({ defaults: { unit: null, other: 'x' } }))
    expect(s.variables).toEqual([{ name: 'unit', default: null }])
    // No defaults left: nothing is sealed.
    const row = f.db.prepare('SELECT defaults_sealed, variables FROM snippets WHERE id = ?').get(s.id) as Record<string, unknown>
    expect(row).toEqual({ defaults_sealed: null, variables: '["unit"]' })
    expect(message(() => store.create(input({ label: 'bad', defaults: { unit: 'a\u0007b' } })))).toBe(
      'variable unit has a control character',
    )
  })

  it('rejects a template error with its message and stores nothing', async () => {
    const { f, store, input, events } = await setup()
    expect(message(() => store.create(input({ script: "echo '{{name}}'" })))).toBe(
      '{{name}} is inside quotes; remove them, OpsDeck quotes values itself',
    )
    expect(message(() => store.create(input({ script: 'echo {{ nope' })))).toMatch(/\S/)
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM snippets').get()).toEqual({ n: 0 })
    expect(events('snippet.create')).toHaveLength(0)
  })

  it('labels are unique ignoring case', async () => {
    const { store, input } = await setup()
    const a = store.create(input({ label: 'Restart' }))
    expect(message(() => store.create(input({ label: 'restart' })))).toBe('Snippet label is already used')
    const b = store.create(input({ label: 'other' }))
    expect(message(() => store.update(b.id, input({ label: 'RESTART' })))).toBe('Snippet label is already used')
    // Renaming itself in another case is fine.
    expect(store.update(a.id, input({ label: 'restart' })).label).toBe('restart')
  })

  it('update re-derives variables and keeps defaults for names that remain', async () => {
    const { store, input } = await setup()
    const s = store.create(input({ script: 'journalctl -u {{unit}} -n {{lines}}', defaults: { unit: 'nginx', lines: '50' } }))
    expect(s.variables).toEqual([
      { name: 'unit', default: 'nginx' },
      { name: 'lines', default: '50' },
    ])
    const u = store.update(s.id, input({ script: 'systemctl status {{ unit }} {{since}}' }))
    expect(u.variables).toEqual([
      { name: 'unit', default: 'nginx' },
      { name: 'since', default: null },
    ])
    expect(u.script).toBe('systemctl status {{ unit }} {{since}}')
    // Given defaults replace the stored ones.
    const v = store.update(s.id, input({ script: u.script, defaults: { since: 'today' } }))
    expect(v.variables).toEqual([
      { name: 'unit', default: null },
      { name: 'since', default: 'today' },
    ])
    expect(store.render(s.id, { unit: 'x' })).toBe('systemctl status x today')
  })

  it('mutations need an unlocked vault, and so do list, get and render', async () => {
    const { f, store, input } = await setup()
    const s = store.create(input())
    f.vault.lock('manual')
    expect(() => store.create(input({ label: 'x' }))).toThrow('vault locked')
    expect(() => store.update(s.id, input({ label: 'y' }))).toThrow('vault locked')
    expect(() => store.delete(s.id)).toThrow('vault locked')
    expect(() => store.get(s.id)).toThrow('vault locked')
    expect(() => store.render(s.id, { unit: 'a' })).toThrow('vault locked')
    await f.vault.unlock('correct horse')
    expect(store.list()).toHaveLength(1)
    expect(store.render(s.id, { unit: 'a' })).toBe('systemctl status a')
  })

  it('list throws while locked', async () => {
    const { f, store, input } = await setup()
    store.create(input())
    f.vault.lock('manual')
    expect(() => store.list()).toThrow('vault locked')
  })

  it('the snippets table holds no script or default in plaintext', async () => {
    const { f, store, input } = await setup()
    const s = store.create(
      input({ script: 'curl -H "Authorization: Bearer s3cr3t-token" -u {{user}}:{{password}}', defaults: { password: 'Hunter22' } }),
    )
    expect(store.get(s.id).variables).toEqual([
      { name: 'user', default: null },
      { name: 'password', default: 'Hunter22' },
    ])
    const dump = JSON.stringify(f.db.prepare('SELECT * FROM snippets').all())
    expect(dump).not.toContain('s3cr3t-token')
    expect(dump).not.toContain('Hunter22')
    expect(dump).not.toContain('Authorization')
    expect(f.db.prepare('SELECT variables FROM snippets').get()).toEqual({ variables: '["user","password"]' })
  })

  it('seals with the snippet id as AAD, so a swapped ciphertext does not open', async () => {
    const { f, store, input } = await setup()
    const a = store.create(input({ label: 'a', script: 'echo a' }))
    const b = store.create(input({ label: 'b', script: 'echo b' }))
    const sealedA = (f.db.prepare('SELECT script_sealed FROM snippets WHERE id = ?').get(a.id) as { script_sealed: string }).script_sealed
    f.db.prepare('UPDATE snippets SET script_sealed = ? WHERE id = ?').run(sealedA, b.id)
    expect(() => store.get(b.id)).toThrow()
    expect(store.get(a.id).script).toBe('echo a')
  })

  it('audits create, update and delete with the label and no script or defaults', async () => {
    const { f, store, input, events } = await setup()
    const s = store.create(input({ script: 'deploy --token s3cr3t-token {{unit}}', tags: ['svc'], defaults: { unit: 'Hunter22' } }))
    store.update(s.id, input({ label: 'deploy', script: 'deploy --token s3cr3t-token {{unit}} {{env}}', tags: ['svc'] }))
    store.delete(s.id)
    const [created] = events('snippet.create')
    const [updated] = events('snippet.update')
    const [deleted] = events('snippet.delete')
    expect(created).toMatchObject({ targetType: 'snippet', targetId: s.id, targetLabel: 'status', details: { variables: ['unit'], tags: ['svc'] } })
    expect(updated).toMatchObject({ targetLabel: 'deploy', details: { variables: ['unit', 'env'], tags: ['svc'] } })
    expect(deleted).toMatchObject({ targetLabel: 'deploy', details: { variables: ['unit', 'env'], tags: ['svc'] } })
    for (const e of [created, updated, deleted]) {
      expect(JSON.stringify(e.details)).not.toContain('s3cr3t-token')
      expect(JSON.stringify(e.details)).not.toContain('Hunter22')
    }
    expect(auditRows(f.db)).not.toContain('s3cr3t-token')
    expect(auditRows(f.db)).not.toContain('Hunter22')
    expect(() => store.get(s.id)).toThrow('snippet not found')
  })

  it('an update that changes nothing is not audited', async () => {
    const { store, input, events } = await setup()
    const s = store.create(input({ defaults: { unit: 'nginx' } }))
    expect(store.update(s.id, input())).toEqual(s)
    expect(events('snippet.update')).toHaveLength(0)
  })

  it('enforces MAX_SNIPPETS, MAX_SCRIPT and MAX_DESCRIPTION', async () => {
    const { f, store, input } = await setup()
    expect(message(() => store.create(input({ script: 'x'.repeat(MAX_SCRIPT + 1) })))).toBe(
      `snippet script must be 1-${MAX_SCRIPT} characters`,
    )
    expect(message(() => store.create(input({ script: '  \n ' })))).toBe(`snippet script must be 1-${MAX_SCRIPT} characters`)
    expect(message(() => store.create(input({ description: 'd'.repeat(MAX_SNIPPET_DESCRIPTION + 1) })))).toBe(
      `snippet description must be at most ${MAX_SNIPPET_DESCRIPTION} characters`,
    )
    expect(message(() => store.create(input({ label: '  ' })))).toBe('snippet label must be 1-120 characters')
    expect(message(() => store.create(input({ tags: ['bad tag'] })))).toBe('a snippet tag is invalid')
    expect(message(() => store.create(input({ tags: Array.from({ length: 17 }, (_, i) => `t${i}`) })))).toBe(
      'a snippet can have at most 16 tags',
    )
    const ts = new Date().toISOString()
    const insert = f.db.prepare(
      "INSERT INTO snippets(id, label, script_sealed, created_at, updated_at) VALUES (?, ?, 'x', ?, ?)",
    )
    for (let i = 0; i < MAX_SNIPPETS; i++) insert.run(`id-${i}`, `s-${i}`, ts, ts)
    expect(message(() => store.create(input({ label: 'one more' })))).toBe(`too many snippets (${MAX_SNIPPETS})`)
  })

  it('render quotes values', async () => {
    const { store, input } = await setup()
    const s = store.create(input())
    expect(store.render(s.id, { unit: 'a;b' })).toBe("systemctl status 'a;b'")
    expect(message(() => store.render(s.id, {}))).toBe('variable unit needs a value')
    expect(message(() => store.render(s.id, { unit: 'a\u0000' }))).toBe('variable unit has a control character')
  })

  it('caches opened scripts per unlock and drops the cache on lock', async () => {
    const { f, store, input } = await setup()
    const s = store.create(input())
    let opens = 0
    const open = f.vault.open.bind(f.vault)
    f.vault.open = (...args) => {
      opens++
      return open(...args)
    }
    store.list()
    store.get(s.id)
    store.render(s.id, { unit: 'a' })
    expect(opens).toBe(0)
    f.vault.lock('manual')
    await f.vault.unlock('correct horse')
    store.list()
    store.list()
    expect(opens).toBe(1)
  })

  it('the ops handlers route snippets:* to the store', async () => {
    const { store, input } = await setup()
    const h = createOpsHandlers({ snippets: store })
    const s = (await h['snippets:create'](input())) as Awaited<ReturnType<SnippetStore['create']>>
    expect(await h['snippets:list']()).toEqual([s])
    expect(await h['snippets:render'](s.id, { unit: 'a b' })).toBe("systemctl status 'a b'")
    expect((await h['snippets:update'](s.id, input({ label: 'st' }))).label).toBe('st')
    await h['snippets:delete'](s.id)
    expect(await h['snippets:list']()).toEqual([])
  })
})
