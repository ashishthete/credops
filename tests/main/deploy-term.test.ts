import { describe, expect, it } from 'vitest'
import { AnsibleTerm, TERM_RESULT_LINES } from '../../src/main/deploy/term'

const plan = { hosts: [{ alias: 'od-1', hostId: 'host-1', label: 'web-1' }] } as never
const ev = (o: object) => JSON.stringify(o)
const text = (t: AnsibleTerm, line: string) => t.stdout(line).map((l) => l.text)

describe('AnsibleTerm', () => {
  it('prints tasks, results and their output the way ansible does', () => {
    const t = new AnsibleTerm(plan)
    expect(t.stdout(ev({ event: 'task_start', name: 'tools check' }))).toEqual([{ hostId: null, text: 'TASK [tools check]' }])
    expect(t.stdout(ev({ event: 'ok', host: 'od-1', task: 'x', changed: true, rc: 0, stdout: 'a\n\nb', truncated: [] }))).toEqual([
      { hostId: 'host-1', text: 'changed: [web-1]' },
      { hostId: 'host-1', text: '    a' },
      { hostId: 'host-1', text: '    b' },
    ])
    // failed_when: false turns a broken shell into ok; the rc and stderr still show
    expect(text(t, ev({ event: 'ok', host: 'od-1', rc: 127, stdout: 'out', stderr: '/bin/bash: not found' }))).toEqual([
      'ok: [web-1] rc=127',
      '    out',
      '    --- stderr',
      '    /bin/bash: not found',
    ])
    expect(text(t, ev({ event: 'failed', host: 'od-1', rc: 2, ignored: true, msg: 'non-zero return code\nmore' }))).toEqual([
      'fatal: [web-1]: FAILED! rc=2 ...ignoring',
      '    msg: non-zero return code',
      '    more',
    ])
    expect(text(t, ev({ event: 'unreachable', host: 'od-1', msg: 'ssh: timeout' }))).toEqual(['fatal: [web-1]: UNREACHABLE!', '    msg: ssh: timeout'])
    expect(text(t, ev({ event: 'skipped', host: 'other', msg: 'Conditional result was False' }))).toEqual(['skipping: [other]'])
  })

  it('prints plays and the plays that ran on no host', () => {
    const t = new AnsibleTerm(plan)
    expect(text(t, ev({ event: 'play_start', name: 'preflight od-1' }))).toEqual(['PLAY [preflight od-1]'])
    expect(text(t, ev({ event: 'no_hosts', why: 'matched' }))).toEqual(['skipping: no hosts matched'])
    expect(text(t, ev({ event: 'no_hosts', why: 'remaining' }))).toEqual(['NO MORE HOSTS LEFT'])
  })

  it('hides no_log output, notes cut output and caps a long result', () => {
    const t = new AnsibleTerm(plan)
    expect(text(t, ev({ event: 'ok', host: 'od-1', no_log: true, stdout: 'hidden' }))).toEqual(['ok: [web-1]', '    (output hidden: this task is no_log)'])
    const long = Array.from({ length: TERM_RESULT_LINES + 5 }, (_, i) => `l${i}`).join('\n')
    const out = text(t, ev({ event: 'ok', host: 'od-1', stdout: long, truncated: ['stdout'] }))
    expect(out).toHaveLength(1 + TERM_RESULT_LINES + 2)
    expect(out.slice(-2)).toEqual(['    … 5 more lines', '    (stdout cut by CredOps)'])
  })

  it('skips streamed lines in a task tail, and labels tap lines with the host', () => {
    const t = new AnsibleTerm(plan)
    expect(text(t, ev({ event: 'ok', host: 'od-1', stdout: 'R2:build\tStep 1/2\nplain' }))).toEqual(['ok: [web-1]', '    plain'])
    expect(t.tap('R2:build\tStep 1/2', 'host-1')).toEqual([{ hostId: 'host-1', text: 'web-1 | Step 1/2' }])
    expect(t.tap('   ', 'host-1')).toEqual([])
  })

  it('prints warnings, the recap with ansible\'s failures count, and plain lines as they are', () => {
    const t = new AnsibleTerm(plan)
    expect(text(t, ev({ event: 'warning', msg: 'old python\nupgrade' }))).toEqual(['[WARNING]: old python', '    upgrade'])
    expect(text(t, ev({ event: 'stats', hosts: { 'od-1': { ok: 3, changed: 1, unreachable: 0, failures: 2, skipped: 4, rescued: 0, ignored: 1 } } }))).toEqual([
      'PLAY RECAP',
      'web-1 : ok=3  changed=1  unreachable=0  failed=2  skipped=4  rescued=0  ignored=1',
    ])
    expect(text(t, 'Skipping callback plugin \'\', unable to load')).toEqual(["Skipping callback plugin '', unable to load"])
    expect(text(t, ev({ event: 'rescued', host: 'od-1' }))).toEqual([])
    expect(t.stderr('ERROR! boom\r')).toEqual([{ hostId: null, text: 'ERROR! boom' }])
    expect(t.stderr('')).toEqual([])
  })
})
