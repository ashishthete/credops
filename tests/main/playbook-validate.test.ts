import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generatePlaybook } from '../../src/main/deploy/generate'
import { planFixture, stepFixture } from './deploy-helpers'
import { EDIT_RULE, validateEditedPlaybook } from '../../src/main/deploy/playbook-validate'

type Obj = Record<string, any>
const DIR = join(__dirname, 'fixtures/playbook-golden')
const GOLDEN = readdirSync(DIR).filter((f) => f.endsWith('.json'))
const gen = (name = 'release-hooks.json'): string => readFileSync(join(DIR, name), 'utf8')

/** Edits a parsed copy of the generated release playbook and validates the result. */
function edit(fn: (plays: Obj[]) => void, name = 'release-hooks.json') {
  const plays = JSON.parse(gen(name)) as Obj[]
  fn(plays)
  return validateEditedPlaybook(JSON.stringify(plays, null, 2), gen(name))
}
const block = (plays: Obj[]): Obj => plays[0].tasks.find((t: Obj) => t.block)
const failing = (r: ReturnType<typeof edit>): string[] => (r.ok ? [] : r.errors.map((e) => e.message))
const NEW = { name: 'extra', 'ansible.builtin.shell': 'echo hi', tags: ['extra'] }

describe('validateEditedPlaybook', () => {
  it.each(GOLDEN)('accepts the generated %s unchanged with an equal canonical text', (f) => {
    const r = validateEditedPlaybook(gen(f), gen(f))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.canonical).toBe(gen(f))
  })

  it('accepts a generated playbook with steps, secrets, params and a when glob unchanged', () => {
    const plan = planFixture()
    const b64 = (x: string): string => Buffer.from(x).toString('base64')
    plan.deployments[0].steps = [
      stepFixture(0, 'before_build', { when: { kind: 'paths', paths: ['db/*'] } }),
      stepFixture(1, 'after_up', { onFailure: 'continue', secrets: [{ envName: 'API_TOKEN', secretId: 'sec-9' }] }, { secretKeys: [{ envName: 'API_TOKEN', key: 'step_1_0' }], paramKeys: [{ envName: 'OD_PARAM_R', valueB64: b64('eu') }] }),
      stepFixture(2, 'after_tag'),
    ]
    plan.deployments[0].preHookB64 = null
    plan.deployments[0].postHookB64 = null
    plan.deployments[0].whenBase = 'f'.repeat(40)
    plan.secretRefs = { ...plan.secretRefs, step_1_0: { secretId: 'sec-9' } }
    const text = generatePlaybook(plan)
    const r = validateEditedPlaybook(text, text)
    expect(failing(r)).toEqual([])
    if (r.ok) expect(r.canonical).toBe(text)
  })

  it('accepts an added shell task with tags', () => {
    expect(edit((p) => block(p).block.splice(2, 0, { ...NEW })).ok).toBe(true)
  })

  it('accepts the other allowed modules', () => {
    const r = edit((p) => {
      const b = block(p).block
      b.push(
        { name: 'a', 'ansible.builtin.command': { argv: ['ls', '-l'] }, register: 'x' },
        { name: 'b', 'ansible.builtin.set_fact': { mine: '{{ d.repo | quote }}' }, when: 'x.rc == 0' },
        { name: 'c', 'ansible.builtin.debug': { msg: 'repo {{ d.repo }}' } },
        { name: 'd', 'ansible.builtin.wait_for': { host: 'localhost', port: 80, timeout: 30 } },
        { name: 'e', 'ansible.builtin.uri': { url: 'http://x.test/', timeout: 20, status_code: [200] } },
        { name: 'f', 'ansible.builtin.fail': { msg: 'stop' }, failed_when: false },
      )
    })
    expect(failing(r)).toEqual([])
  })

  it('rejects invalid JSON, a BOM, NaN and a duplicate key with the line', () => {
    const g = gen()
    expect(validateEditedPlaybook('[', g)).toMatchObject({ ok: false })
    expect(validateEditedPlaybook('﻿' + g, g)).toEqual({ ok: false, errors: [{ line: 1, message: EDIT_RULE.bom }] })
    expect(validateEditedPlaybook('[{"a": NaN}]', g)).toMatchObject({ ok: false })
    const dup = validateEditedPlaybook('[\n{"name": "a",\n "name": "b"}]', g)
    expect(dup).toEqual({ ok: false, errors: [{ line: 3, message: EDIT_RULE.duplicateKey('name') }] })
  })

  it('reports the line of the offending task', () => {
    const plays = JSON.parse(gen()) as Obj[]
    block(plays).block.splice(1, 0, { name: 'x', 'ansible.builtin.include_tasks': 'a.yml' })
    const text = JSON.stringify(plays, null, 2)
    const r = validateEditedPlaybook(text, gen())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const at = text.split('\n')[r.errors[0].line - 1]
      expect(at).toContain('include_tasks')
    }
  })

  const lockWrap = (extra: Obj) => (p: Obj[]) => {
    const [prep, lock] = p[0].tasks.splice(0, 2)
    p[0].tasks.unshift({ name: 'wrap', block: [prep, lock], ...extra })
  }
  const bad: [string, (p: Obj[]) => void, string][] = [
    ['delegate_to on a new task', (p) => block(p).block.push({ ...NEW, delegate_to: 'localhost' }), EDIT_RULE.protectedTask],
    ['a changed health delegate_to task', (p) => { block(p).block.find((t: Obj) => t.delegate_to).timeout = 5 }, EDIT_RULE.protectedTask],
    ['hosts: all', (p) => { p[0].hosts = 'all' }, EDIT_RULE.playOwned('hosts')],
    ['include_tasks', (p) => block(p).block.push({ name: 'i', include_tasks: 'x.yml' }), EDIT_RULE.taskKey('include_tasks')],
    ['roles on a play', (p) => { p[0].roles = ['x'] }, EDIT_RULE.playKey('roles')],
    ['vars_files', (p) => { p[0].vars_files = ['x.yml'] }, EDIT_RULE.playKey('vars_files')],
    ['vars_prompt', (p) => { p[0].vars_prompt = [] }, EDIT_RULE.playKey('vars_prompt')],
    ['handlers', (p) => { p[0].handlers = [] }, EDIT_RULE.playKey('handlers')],
    ['pre_tasks', (p) => { p[0].pre_tasks = [] }, EDIT_RULE.playKey('pre_tasks')],
    ['action', (p) => block(p).block.push({ name: 'a', action: 'shell echo hi' }), EDIT_RULE.taskKey('action')],
    ['args', (p) => block(p).block.push({ ...NEW, args: { chdir: '/' } }), EDIT_RULE.taskKey('args')],
    ['module_defaults', (p) => block(p).block.push({ ...NEW, module_defaults: {} }), EDIT_RULE.taskKey('module_defaults')],
    ['assert', (p) => block(p).block.push({ name: 'a', 'ansible.builtin.assert': { that: ['true'] } }), EDIT_RULE.taskKey('ansible.builtin.assert')],
    ['pause', (p) => block(p).block.push({ name: 'a', 'ansible.builtin.pause': { seconds: 1 } }), EDIT_RULE.taskKey('ansible.builtin.pause')],
    ['with_items', (p) => block(p).block.push({ ...NEW, with_items: [1] }), EDIT_RULE.taskKey('with_items')],
    ['loop', (p) => block(p).block.push({ ...NEW, loop: [1] }), EDIT_RULE.taskKey('loop')],
    ['uri.src', (p) => block(p).block.push({ name: 'u', 'ansible.builtin.uri': { url: 'http://x.test', src: '/etc/passwd' } }), EDIT_RULE.moduleParam('uri', 'src')],
    ['lookup(', (p) => block(p).block.push({ name: 'l', 'ansible.builtin.shell': "echo {{ lookup('env','HOME') }}" }), EDIT_RULE.lookup],
    ['jinja statement', (p) => block(p).block.push({ name: 'l', 'ansible.builtin.shell': '{% for x in y %}{% endfor %}' }), EDIT_RULE.jinjaStatement],
    ['{{ s }} in debug', (p) => block(p).block.push({ name: 'l', 'ansible.builtin.debug': { msg: '{{ s }}' } }), EDIT_RULE.secretRef],
    ['{{ s.key }} in shell', (p) => block(p).block.push({ name: 'l', 'ansible.builtin.shell': 'echo {{ s.env_1 }}' }), EDIT_RULE.secretRef],
    ['s via a filter chain', (p) => block(p).block.push({ name: 'l', 'ansible.builtin.debug': { msg: '{{ s | to_json }}' } }), EDIT_RULE.jinjaExpr],
    ['hostvars', (p) => block(p).block.push({ name: 'l', 'ansible.builtin.debug': { msg: '{{ hostvars }}' } }), EDIT_RULE.secretRef],
    ['the become password', (p) => block(p).block.push({ name: 'l', 'ansible.builtin.debug': { msg: '{{ ansible_become_password }}' } }), EDIT_RULE.secretRef],
    ['a dunder path', (p) => block(p).block.push({ name: 'l', 'ansible.builtin.debug': { msg: '{{ d.__class__ }}' } }), EDIT_RULE.jinjaExpr],
    ['debug var', (p) => block(p).block.push({ name: 'l', 'ansible.builtin.debug': { var: 's' } }), EDIT_RULE.moduleParam('debug', 'var')],
    ['Jinja in a uri header key', (p) => block(p).block.push({ name: 'u', 'ansible.builtin.uri': { url: 'http://x.test', headers: { '{{ s.env_1 }}': 'x' } } }), EDIT_RULE.secretRef],
    ['set_fact ansible_connection', (p) => block(p).block.push({ name: 'l', 'ansible.builtin.set_fact': { ansible_connection: 'local' } }), EDIT_RULE.reserved('ansible_connection')],
    ['register od_failed', (p) => block(p).block.push({ ...NEW, register: 'od_failed' }), EDIT_RULE.reserved('od_failed')],
    ['a removed lock task', (p) => { p[0].tasks = p[0].tasks.filter((t: Obj) => t.name !== 'lock od-1') }, EDIT_RULE.lockRemoved('lock od-1')],
    ['a changed od.lock_b64', (p) => { p[0].vars.od.lock_b64 = 'AAAA' }, EDIT_RULE.playOwned('vars')],
    ['a changed lock command', (p) => { p[0].tasks[1]['ansible.builtin.shell'].cmd += '\ntrue' }, EDIT_RULE.protectedTask],
    ['when: false added to a lock task', (p) => { p[0].tasks[1].when = false }, EDIT_RULE.protectedTask],
    ['ignore_errors added to a lock task', (p) => { p[0].tasks[1].ignore_errors = true }, EDIT_RULE.protectedTask],
    ['tags added to a lock task', (p) => { p[0].tasks[1].tags.push('extra') }, EDIT_RULE.protectedTask],
    ['a when: false wrapper around the lock', lockWrap({ when: false }), EDIT_RULE.protectedMoved('lock od-1')],
    ['an ignore_errors wrapper around the lock', lockWrap({ ignore_errors: true }), EDIT_RULE.protectedMoved('lock od-1')],
    ['a plain wrapper around the lock', lockWrap({}), EDIT_RULE.protectedMoved('lock od-1')],
    ['the lock moved into a rescue', (p) => { const [, lock] = p[0].tasks.splice(0, 2); block(p).rescue.push(lock) }, EDIT_RULE.protectedMoved('lock od-1')],
    ['the lock after a user task', (p) => { p[0].tasks.unshift({ ...NEW }) }, EDIT_RULE.lockOrder('lock prep od-1')],
    ['lock before lock prep', (p) => { p[0].tasks.splice(0, 2, p[0].tasks[1], p[0].tasks[0]) }, EDIT_RULE.lockOrder('lock prep od-1')],
    ['a deployment block wrapped by when: false', (p) => { block(p).when = false }, EDIT_RULE.protectedMoved('env dep1')],
    ['the env task moved out of its deployment block', (p) => { const i = block(p).block.findIndex((t: Obj) => t.no_log); p[0].tasks.push(block(p).block.splice(i, 1)[0]) }, EDIT_RULE.protectedMoved('env dep1')],
    ['removed no_log on the env task', (p) => { delete block(p).block.find((t: Obj) => t.no_log).no_log }, EDIT_RULE.secretRef],
    ['a timeout of 99999', (p) => block(p).block.push({ ...NEW, timeout: 99999 }), EDIT_RULE.timeout],
    ['a module timeout of 99999', (p) => block(p).block.push({ name: 'u', 'ansible.builtin.uri': { url: 'http://x.test', timeout: 99999 } }), EDIT_RULE.timeout],
    ['a free condition', (p) => block(p).block.push({ ...NEW, when: 'd.repo is defined' }), EDIT_RULE.condition],
    ['become_user', (p) => block(p).block.push({ ...NEW, become_user: 'root' }), EDIT_RULE.taskKey('become_user')],
    ['environment', (p) => block(p).block.push({ ...NEW, environment: { A: 'b' } }), EDIT_RULE.taskKey('environment')],
    ['a tag that fakes the lock', (p) => block(p).block.push({ ...NEW, tags: ['od_step=unlock'] }), EDIT_RULE.protectedTask],
    ['task vars named d', (p) => block(p).block.push({ ...NEW, vars: { d: 'x' } }), EDIT_RULE.reserved('d')],
    ['a removed play', (p) => p.pop(), EDIT_RULE.playCount],
    ['an unknown module', (p) => block(p).block.push({ name: 'x', 'ansible.builtin.copy': { src: 'a', dest: 'b' } }), EDIT_RULE.taskKey('ansible.builtin.copy')],
    ['two modules', (p) => block(p).block.push({ ...NEW, 'ansible.builtin.fail': { msg: 'x' } }), EDIT_RULE.oneModule],
  ]
  it.each(bad)('rejects %s', (_n, fn, rule) => {
    const r = edit(fn)
    expect(r.ok).toBe(false)
    expect(failing(r)).toContain(rule)
    if (!r.ok) for (const e of r.errors) expect(e.line).toBeGreaterThan(0)
  })

  it('rejects an unlock that is not last, and accepts one with a user task before it', () => {
    expect(failing(edit((p) => { p[0].tasks.push({ ...NEW }) }, 'unlock.json'))).toContain(EDIT_RULE.lockOrder(String(JSON.parse(gen('unlock.json'))[0].tasks[0].name)))
    expect(edit((p) => { p[0].tasks.unshift({ ...NEW }) }, 'unlock.json').ok).toBe(true)
  })

  it('accepts a user task between lock and the deployment blocks, and one inside a deployment block', () => {
    expect(edit((p) => { p[0].tasks.splice(2, 0, { ...NEW }) }).ok).toBe(true)
    expect(edit((p) => { block(p).rescue.push({ ...NEW }) }).ok).toBe(true)
  })

  it('accepts a generated changed_when on an edited block task', () => {
    expect(edit((p) => block(p).block.push({ ...NEW, changed_when: false })).ok).toBe(true)
  })

  it('names the rule for a removed lock task', () => {
    const r = edit((p) => { p[0].tasks = p[0].tasks.filter((t: Obj) => t.name !== 'lock od-1') })
    expect(failing(r)).toContain(EDIT_RULE.lockRemoved('lock od-1'))
  })

  it('names the rule for a secret reference outside the generated tasks', () => {
    expect(failing(edit((p) => block(p).block.push({ name: 'l', 'ansible.builtin.debug': { msg: '{{ s }}' } })))).toContain(EDIT_RULE.secretRef)
  })

  it('does not echo a secret-reading generated string into another task', () => {
    const plays = JSON.parse(gen()) as Obj[]
    const env = block(plays).block.find((t: Obj) => t.no_log)
    const stdin = env['ansible.builtin.shell'].stdin as string
    expect(stdin).toContain('{{ s.')
    block(plays).block.push({ name: 'leak', 'ansible.builtin.debug': { msg: stdin } })
    expect(validateEditedPlaybook(JSON.stringify(plays, null, 2), gen()).ok).toBe(false)
  })

  it('rejects text over 256 KB', () => {
    expect(validateEditedPlaybook(' '.repeat(256 * 1024 + 1), gen())).toMatchObject({ ok: false })
  })

  it('never throws on arbitrary input', () => {
    for (const t of ['', 'null', '{}', '[1]', '[[]]', '[{"tasks":5}]', '"x"', '[{"tasks":[null,1,"a",[]]}]']) {
      expect(() => validateEditedPlaybook(t, gen())).not.toThrow()
    }
  })
})
