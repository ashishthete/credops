import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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

  const bad: [string, (p: Obj[]) => void][] = [
    ['delegate_to on a new task', (p) => block(p).block.push({ ...NEW, delegate_to: 'localhost' })],
    ['a changed health delegate_to task', (p) => { block(p).block.find((t: Obj) => t.delegate_to).timeout = 5 }],
    ['hosts: all', (p) => { p[0].hosts = 'all' }],
    ['include_tasks', (p) => block(p).block.push({ name: 'i', include_tasks: 'x.yml' })],
    ['roles on a play', (p) => { p[0].roles = ['x'] }],
    ['vars_files', (p) => { p[0].vars_files = ['x.yml'] }],
    ['vars_prompt', (p) => { p[0].vars_prompt = [] }],
    ['handlers', (p) => { p[0].handlers = [] }],
    ['pre_tasks', (p) => { p[0].pre_tasks = [] }],
    ['action', (p) => block(p).block.push({ name: 'a', action: 'shell echo hi' })],
    ['args', (p) => block(p).block.push({ ...NEW, args: { chdir: '/' } })],
    ['module_defaults', (p) => block(p).block.push({ ...NEW, module_defaults: {} })],
    ['assert', (p) => block(p).block.push({ name: 'a', 'ansible.builtin.assert': { that: ['true'] } })],
    ['pause', (p) => block(p).block.push({ name: 'a', 'ansible.builtin.pause': { seconds: 1 } })],
    ['with_items', (p) => block(p).block.push({ ...NEW, with_items: [1] })],
    ['loop', (p) => block(p).block.push({ ...NEW, loop: [1] })],
    ['uri.src', (p) => block(p).block.push({ name: 'u', 'ansible.builtin.uri': { url: 'http://x.test', src: '/etc/passwd' } })],
    ['lookup(', (p) => block(p).block.push({ name: 'l', 'ansible.builtin.shell': "echo {{ lookup('env','HOME') }}" })],
    ['jinja statement', (p) => block(p).block.push({ name: 'l', 'ansible.builtin.shell': '{% for x in y %}{% endfor %}' })],
    ['{{ s }} in debug', (p) => block(p).block.push({ name: 'l', 'ansible.builtin.debug': { msg: '{{ s }}' } })],
    ['{{ s.key }} in shell', (p) => block(p).block.push({ name: 'l', 'ansible.builtin.shell': 'echo {{ s.env_1 }}' })],
    ['s via a filter chain', (p) => block(p).block.push({ name: 'l', 'ansible.builtin.debug': { msg: '{{ s | to_json }}' } })],
    ['hostvars', (p) => block(p).block.push({ name: 'l', 'ansible.builtin.debug': { msg: '{{ hostvars }}' } })],
    ['the become password', (p) => block(p).block.push({ name: 'l', 'ansible.builtin.debug': { msg: '{{ ansible_become_password }}' } })],
    ['a dunder path', (p) => block(p).block.push({ name: 'l', 'ansible.builtin.debug': { msg: '{{ d.__class__ }}' } })],
    ['debug var', (p) => block(p).block.push({ name: 'l', 'ansible.builtin.debug': { var: 's' } })],
    ['set_fact ansible_connection', (p) => block(p).block.push({ name: 'l', 'ansible.builtin.set_fact': { ansible_connection: 'local' } })],
    ['register od_failed', (p) => block(p).block.push({ ...NEW, register: 'od_failed' })],
    ['a removed lock task', (p) => { p[0].tasks = p[0].tasks.filter((t: Obj) => t.name !== 'lock od-1') }],
    ['a changed od.lock_b64', (p) => { p[0].vars.od.lock_b64 = 'AAAA' }],
    ['a changed lock command', (p) => { p[0].tasks[1]['ansible.builtin.shell'].cmd += '\ntrue' }],
    ['removed no_log on the env task', (p) => { delete block(p).block.find((t: Obj) => t.no_log).no_log }],
    ['a timeout of 99999', (p) => block(p).block.push({ ...NEW, timeout: 99999 })],
    ['a module timeout of 99999', (p) => block(p).block.push({ name: 'u', 'ansible.builtin.uri': { url: 'http://x.test', timeout: 99999 } })],
    ['a free condition', (p) => block(p).block.push({ ...NEW, when: 'd.repo is defined' })],
    ['become_user', (p) => block(p).block.push({ ...NEW, become_user: 'root' })],
    ['environment', (p) => block(p).block.push({ ...NEW, environment: { A: 'b' } })],
    ['a tag that fakes the lock', (p) => block(p).block.push({ ...NEW, tags: ['od_step=unlock'] })],
    ['task vars named d', (p) => block(p).block.push({ ...NEW, vars: { d: 'x' } })],
    ['a removed play', (p) => p.pop()],
    ['an unknown module', (p) => block(p).block.push({ name: 'x', 'ansible.builtin.copy': { src: 'a', dest: 'b' } })],
    ['two modules', (p) => block(p).block.push({ ...NEW, 'ansible.builtin.fail': { msg: 'x' } })],
  ]
  it.each(bad)('rejects %s', (_n, fn) => {
    const r = edit(fn)
    expect(r.ok).toBe(false)
    if (!r.ok) for (const e of r.errors) expect(e.line).toBeGreaterThan(0)
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
