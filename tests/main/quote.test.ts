import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_VARIABLES } from '../../src/shared/ops'
import { checkConfirm, confirmNeeded, isDestructive, ProtectError, protectionFor } from '../../src/main/ops/protect'
import { checkValue, parseTemplate, renderTemplate, shJoin, shQuote, TemplateError } from '../../src/main/ops/quote'

// Local shells only. Every run gets cwd = a tmp dir, HOME = that dir and an env of only MARKER and PATH,
// so no rc file, key or real tool is reached. Hostile values only ever `touch` a marker inside the tmp dir.
const SHELLS = ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/dash'].filter((sh) => existsSync(sh))
let tmp = ''
let markers = 0

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'opsdeck-quote-'))
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** Runs `script` with `shell -c`; returns stdout and whether the script touched its marker. */
function run(shell: string, script: string): { out: string; touched: boolean } {
  const marker = join(tmp, `marker-${++markers}`)
  let out: string
  try {
    out = execFileSync(shell, ['-c', script], {
      cwd: tmp,
      env: { MARKER: marker, PATH: '/usr/bin:/bin', HOME: tmp },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    })
  } catch (err) {
    out = String((err as { stdout?: unknown }).stdout ?? '')
  }
  return { out, touched: existsSync(marker) }
}

const HOSTILE = [
  `'; touch "$MARKER"; '`,
  '$(touch "$MARKER")',
  '`touch "$MARKER"`',
  '"$(touch "$MARKER")"',
  `'"$(touch "$MARKER")"'`,
  'a[$(touch "$MARKER")]',
  `\\'; touch "$MARKER"; '`,
  `') ; touch "$MARKER" ; ('`,
  '} ; touch "$MARKER" ; {',
  '`; touch "$MARKER"; `',
  '\n touch "$MARKER"\n',
  '$((a[$(touch "$MARKER")]))',
]

function message(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(TemplateError)
    return (err as Error).message
  }
  throw new Error('expected a TemplateError')
}

describe('shQuote', () => {
  it('shQuote leaves safe words alone and single-quotes everything else', () => {
    expect(shQuote('abc')).toBe('abc')
    expect(shQuote('a/b.c')).toBe('a/b.c')
    expect(shQuote('x=1')).toBe('x=1')
    expect(shQuote('user@host:22')).toBe('user@host:22')
    expect(shQuote('')).toBe("''")
    expect(shQuote('a b')).toBe("'a b'")
    expect(shQuote("it's")).toBe(`'it'\\''s'`)
  })

  it('quotes any word that starts with = - % ~ or #', () => {
    for (const s of ['=ls', '-rf', '--force', '%1', '~', '~root', '#x']) expect(shQuote(s)).toBe(`'${s}'`)
  })

  it('refuses NUL, which no shell word can carry', () => {
    expect(() => shQuote('a\u0000b')).toThrow(/NUL/)
  })

  it('shQuote round-trips hostile values through a real sh', () => {
    const values = [
      '`id`',
      '$(id)',
      '$HOME',
      'a;b',
      'a && b',
      ...HOSTILE,
      '"\n"',
      '*',
      '~',
      '-rf',
      '!',
      'a!b !! !$',
      'x'.repeat(4096),
      'naïve 日本語 🚀',
      "'",
      "''",
      '\\',
      '\t',
    ]
    for (const shell of SHELLS) {
      for (const v of values) {
        const { out, touched } = run(shell, 'printf %s ' + shQuote(v))
        expect({ shell, out }).toEqual({ shell, out: v })
        expect(touched).toBe(false)
      }
    }
  })

  it('keeps zsh = expansion away from values', () => {
    for (const shell of SHELLS) {
      for (const v of ['=ls', '=nosuchcmd']) expect(run(shell, 'printf %s ' + shQuote(v)).out).toBe(v)
    }
  })
})

describe('shJoin', () => {
  it('shJoin keeps each argv element one word', () => {
    const argv = ['a b', "it's", '', '$(touch "$MARKER")', '*', '-n', '\n', '=ls', ...HOSTILE]
    const loop = `sh -c 'for a in "$@"; do printf "[%s]" "$a"; done' _ `
    for (const shell of SHELLS) {
      const { out, touched } = run(shell, loop + shJoin(argv))
      expect(out).toBe(argv.map((a) => `[${a}]`).join(''))
      expect(touched).toBe(false)
    }
  })
})

describe('parseTemplate', () => {
  it('parseTemplate finds variables in first-use order and ignores comments', () => {
    const t = parseTemplate('echo {{a}} {{ b }} {{a}} # {{c}}')
    expect(t.variables).toEqual(['a', 'b'])
    expect(t.parts).toEqual([
      { text: 'echo ' },
      { variable: 'a' },
      { text: ' ' },
      { variable: 'b' },
      { text: ' ' },
      { variable: 'a' },
      { text: ' # {{c}}' },
    ])
  })

  it('treats # as a comment only at the start of a word', () => {
    expect(parseTemplate('echo a#{{v}}').variables).toEqual(['v'])
    expect(parseTemplate('echo ${#x} $# {{v}}').variables).toEqual(['v'])
    expect(parseTemplate('echo a # note {{c}}\necho {{v}}').variables).toEqual(['v'])
    expect(parseTemplate('echo $(echo a # {{c}} )\n) {{v}}').variables).toEqual(['v'])
  })

  it('rejects a placeholder inside single or double quotes', () => {
    for (const script of [`echo '{{a}}'`, 'echo "x{{a}}"', "echo $'{{a}}'", 'echo \\{{a}}', 'echo "\\{{a}}"']) {
      expect(message(() => parseTemplate(script))).toBe('{{a}} is inside quotes; remove them, OpsDeck quotes values itself')
    }
  })

  it('reads backslashes the way the shell does', () => {
    // \" inside double quotes does not end them
    expect(() => parseTemplate('echo "\\"{{a}}"')).toThrow('{{a}} is inside quotes')
    // inside '…' a backslash is literal, so the quote closes and the placeholder is unquoted
    expect(parseTemplate("echo '\\'{{a}}").variables).toEqual(['a'])
    const t = parseTemplate("printf %s '\\'{{a}}")
    for (const shell of SHELLS) expect(run(shell, renderTemplate(t, { a: "x'y" }, {})).out).toBe("\\x'y")
    // $'\'' is a quote character inside ANSI-C quoting; dash reads it differently, so refuse it
    expect(() => parseTemplate("echo $'\\'{{a}}'")).toThrow('{{a}} is inside quotes')
    expect(() => parseTemplate("echo $'\\''{{a}}'")).toThrow(TemplateError)
    // a backslash before " outside quotes escapes the quote, not the placeholder
    expect(parseTemplate('echo \\"{{a}}').variables).toEqual(['a'])
  })

  it('allows placeholders inside command substitution', () => {
    expect(parseTemplate('echo $(cat {{f}})').variables).toEqual(['f'])
    expect(parseTemplate('echo $(echo $(cat {{f}}))').variables).toEqual(['f'])
  })

  it('rejects placeholders inside backticks, including the verified exploit', () => {
    for (const script of ['echo `cat {{f}}`', 'echo "`cat {{f}}`"', 'echo `echo $(cat {{f}})`']) {
      expect(message(() => parseTemplate(script))).toBe('{{f}} is inside backticks; use $( ) instead')
    }
    // control: the same template rendered without the parser runs the payload
    const value = '`; touch "$MARKER"; `'
    expect(run('/bin/sh', 'echo `echo ' + shQuote(value) + '`').touched).toBe(true)
  })

  it('rejects placeholders in arithmetic, [[ ]] and array subscripts', () => {
    const arith = "{{n}} can't be used in arithmetic or [[ ]]; pass it through a variable and validate it"
    for (const script of [
      'echo $(( {{n}} + 1 ))',
      'echo "$(( {{n}} + 1 ))"',
      '(( {{n}} > 1 ))',
      'for ((i={{n}}; i<3; i++)); do :; done',
      'echo $[ {{n}} + 1 ]',
      '[[ {{n}} == x ]]',
      'if [[ -n $(echo {{n}}) ]]; then :; fi',
      'a[{{n}}]=1',
      'a[$(echo {{n}})]=1',
      'echo $(( $(echo {{n}}) ))',
    ]) {
      expect(message(() => parseTemplate(script))).toBe(arith)
    }
    // [ ] and test compare without evaluating, and a word after [[x is not a [[ command
    expect(parseTemplate('[ {{n}} -eq 1 ]').variables).toEqual(['n'])
    expect(parseTemplate('test {{n}} -eq 1').variables).toEqual(['n'])
  })

  it('rejects placeholders inside ${ } and right after $', () => {
    expect(message(() => parseTemplate('echo ${x:-{{v}}}'))).toBe("{{v}} can't be used inside ${ }; assign it to a variable first")
    expect(message(() => parseTemplate('echo ${a[{{v}}]}'))).toBe("{{v}} can't be used inside ${ }; assign it to a variable first")
    expect(message(() => parseTemplate('echo ${{v}}'))).toBe("{{v}} can't follow a $")
  })

  it('refuses constructs whose quoting differs between shells', () => {
    // zsh closes the $( ) at the case pattern, bash and sh don't
    expect(() => parseTemplate('echo "$(case a in a) echo ") {{v}} ";; esac)"')).toThrow(/case/)
    // ' inside "${ }" is a quote in bash and a letter in zsh
    expect(() => parseTemplate(`echo "\${x:-'a'}" {{v}}`)).toThrow(/\$\{ \}/)
    // an unterminated quote or substitution leaves the placeholder's context unknown
    expect(() => parseTemplate("echo {{v}} '")).toThrow(/unterminated/)
    expect(() => parseTemplate('echo $(echo {{v}}')).toThrow(/unterminated/)
    // none of this matters without variables
    expect(parseTemplate('echo "$(case a in a) echo ") x ";; esac)"').variables).toEqual([])
  })

  it('rejects variables with a here-document', () => {
    const heredoc = "a script with variables can't use a here-document"
    for (const script of [
      'cat <<EOF\n{{a}}\nEOF',
      'cat <<-X\n\t{{a}}\n\tX',
      "cat <<'EOF'\nhi\nEOF\necho {{a}}",
      'echo {{a}}; cat <<EOF\nhi\nEOF',
      'x=$(cat <<EOF\n{{a}}\nEOF\n)',
      'x=$(cat <<EOF\nhi\nEOF\n); echo {{a}}',
      'echo `cat <<EOF`\necho {{a}}',
      // << is also a shift; refused all the same, in every unquoted state
      'echo $(( 1 << 2 )) {{a}}',
    ]) {
      expect(message(() => parseTemplate(script))).toBe(heredoc)
    }
    expect(parseTemplate('cat <<< {{a}}').variables).toEqual(['a'])
    // a body is skipped, so its quotes and comments don't leak into the script
    expect(parseTemplate(`cat <<EOF\nit's "odd # (\nEOF\necho done`).variables).toEqual([])
    expect(parseTemplate(`cat <<-'X'\n\tit's\n\tX\necho "ok"`).variables).toEqual([])
    expect(parseTemplate('echo "<<EOF" {{a}}').variables).toEqual(['a'])
  })

  it('rejects malformed placeholders and bad names', () => {
    for (const script of ['echo {{}}', 'echo {{A}}', 'echo {{1a}}', 'echo {{a-b}}', 'echo {{a}', 'echo {{ a b }}', "awk '{{print}}'"]) {
      expect(() => parseTemplate(script)).toThrow(TemplateError)
    }
    for (const name of ['constructor', '__proto__', 'prototype']) {
      expect(() => parseTemplate(`echo {{${name}}}`)).toThrow(TemplateError)
    }
    const many = Array.from({ length: MAX_VARIABLES + 1 }, (_, i) => `{{v${i}}}`).join(' ')
    expect(message(() => parseTemplate('echo ' + many))).toBe(`a script can have at most ${MAX_VARIABLES} variables`)
    expect(parseTemplate('echo ' + Array.from({ length: MAX_VARIABLES }, (_, i) => `{{v${i}}}`).join(' ')).variables).toHaveLength(MAX_VARIABLES)
  })

  it('never echoes template text it could not read', () => {
    const msg = message(() => parseTemplate('echo ok\necho {{S3cret-x}}'))
    expect(msg).not.toContain('S3cret')
    expect(msg).toContain('line 2')
  })

  it('accepted templates keep every hostile value one literal word in sh, bash and zsh', () => {
    const accepted = [
      'printf %s {{v}}',
      "printf '%s\\n' {{v}}",
      'printf %s --name={{v}}',
      'printf %s $(printf %s {{v}})',
      'printf %s $( printf %s $(printf %s {{v}}) )',
      'x={{v}}; printf %s "$x"',
      'printf %s "a\\"" {{v}} \'b\'',
      'printf %s "$(echo a)" {{v}}',
      "printf %s $'a\\\\' {{v}}",
      'printf %s "\\`" {{v}}',
      'printf %s \\"{{v}}',
      'printf %s a # note {{c}}\nprintf %s {{v}}',
      'printf %s ${HOME} "${x:-a}" ${#x} {{v}}',
      'case {{v}} in x) echo x;; *) printf %s other;; esac',
      '[ {{v}} = x ] || printf %s no',
      'test {{v}} -eq 1 2>/dev/null || printf %s no',
      "for i in {{v}} b; do printf '[%s]' \"$i\"; done",
      '( printf %s {{v}} )',
      '{ printf %s {{v}}; }',
      'cat <<< {{v}}',
      'printf %s {{v}}{{v}}',
      'a=( {{v}} ); printf %s "${a[0]}"',
    ]
    for (const script of accepted) {
      const t = parseTemplate(script)
      for (const value of HOSTILE) {
        const command = renderTemplate(t, { v: value, c: 'unused' }, {})
        for (const shell of SHELLS) {
          expect({ shell, script, value, touched: run(shell, command).touched }).toEqual({ shell, script, value, touched: false })
        }
      }
    }
  })

  // Fix round 1: forms the security review found slipping a placeholder into evaluated context.
  const BYPASS = [
    // (( opens arithmetic even glued to a reserved word or a `(`, not only at a clean word start
    'for((i={{n}};i<1;i++)); do :; done',
    'if(( {{n}} > 1 )); then :; fi',
    'while(( {{n}} )); do break; done',
    'until(( {{n}} )); do break; done',
    'echo hi;(( {{n}} ))',
    // [[ in every form, including [[( with no blank
    '[[( {{n}} -eq 1 )]]',
    '[[ {{n}} == x ]]',
    'echo hi;[[ {{n}} ]]',
    // an array subscript stays open across blanks and operators until ] ; & | or a newline
    'a[ {{n}} ]=1',
    'a[1 + {{n}}]=1',
    'declare -a a; a[0 + {{n}}]=x',
    // comments carrying a quote, backtick or backslash parse as code where # is literal (zsh -i)
    "echo hi # don't forget\necho {{n}} done",
    'echo {{n}} # say "hi"',
    'echo {{n}} # `x`',
    'echo {{n}} # back\\slash',
    // backslash-newline line continuation, in each spot the review hit
    '$\\\n{{n}}',
    'echo x \\\n{{n}}',
    '(\\\n( {{n}} ))',
    'cat <\\\n<EOF\n{{n}}\nEOF',
  ]

  it('fix round 1: refuses every reported bypass form', () => {
    for (const script of BYPASS) {
      expect(message(() => parseTemplate(script))).toMatch(
        /can't|arithmetic|\[\[|line continuation|comment|here-document/,
      )
    }
  })

  it('fix round 1: a refused form never builds a command, so no shell runs it', () => {
    // The guard throws at parse, so the render pipeline never produces a string for any shell.
    for (const script of BYPASS) {
      expect(() => renderTemplate(parseTemplate(script), { n: '$(touch "$MARKER")' }, {})).toThrow(TemplateError)
    }
  })

  it('fix round 1: the raw subscript and (( vectors really do run, which is why they are refused', () => {
    // Controls: the same payload substituted raw, as a guardless templater would, touches the marker.
    // Run under bash, where both forms evaluate; it proves the vectors are real and worth refusing.
    if (SHELLS.includes('/bin/bash')) {
      for (const red of ['a[$(touch "$MARKER")]=1', 'for((i=$(touch "$MARKER");i<0;i++)); do :; done']) {
        expect({ red, touched: run('/bin/bash', red).touched }).toEqual({ red, touched: true })
      }
    }
  })
})

describe('renderTemplate', () => {
  it('renderTemplate quotes values and uses defaults', () => {
    const t = parseTemplate('ls {{dir}}')
    expect(renderTemplate(t, { dir: 'a b; rm x' }, {})).toBe("ls 'a b; rm x'")
    expect(renderTemplate(t, {}, { dir: '/srv' })).toBe('ls /srv')
    expect(renderTemplate(t, { dir: '' }, { dir: '/srv' })).toBe("ls ''")
    expect(() => renderTemplate(t, {}, {})).toThrow('variable dir needs a value')
    expect(() => renderTemplate(t, {}, { dir: null })).toThrow('variable dir needs a value')
  })

  it('reads only own properties of values and defaults', () => {
    const t = parseTemplate('echo {{constructo}}')
    const values = Object.create({ constructo: 'inherited' }) as Record<string, string>
    expect(() => renderTemplate(t, values, {})).toThrow('variable constructo needs a value')
  })

  it('renders a concatenated word as one word', () => {
    const t = parseTemplate('printf "[%s]" --name={{n}}')
    for (const shell of SHELLS) expect(run(shell, renderTemplate(t, { n: 'a b; c' }, {})).out).toBe('[--name=a b; c]')
  })

  it('checks every value it renders', () => {
    const t = parseTemplate('echo {{a}}')
    expect(() => renderTemplate(t, { a: 'x\u001b[2J' }, {})).toThrow('variable a has a control character')
    expect(() => renderTemplate(t, {}, { a: 'x'.repeat(4097) })).toThrow('variable a is longer than 4096 characters')
  })
})

describe('checkValue', () => {
  it('rejects control characters in values', () => {
    for (const bad of ['\u0000', '\u001b[2J', '\u0085', '\r', '\u007f', 'a\u009bb']) {
      expect(() => checkValue('a', bad)).toThrow('variable a has a control character')
    }
    expect(checkValue('a', 'tab\there\nnew line')).toBe('tab\there\nnew line')
  })

  it('never carries the value in its message', () => {
    try {
      checkValue('pw', 'Hunter22\u0000')
    } catch (err) {
      expect((err as Error).message).not.toContain('Hunter22')
      return
    }
    throw new Error('expected a throw')
  })
})

describe('protect', () => {
  it('isDestructive matches the pattern list on word boundaries', () => {
    for (const c of ['rm -rf /tmp/x', 'sudo systemctl restart nginx', 'docker compose down', 'echo hi > /dev/sda']) {
      expect(isDestructive(c, false)).toBe(true)
    }
    for (const c of ['echo rmdirlike', 'ls -la', 'firmware', 'docker ps', 'echo hi > /dev/null']) {
      expect(isDestructive(c, false)).toBe(false)
    }
    // `-` is a word boundary, so `rmdir-like` asks for the name: over-confirmation is the safe direction (Task 1 ruling)
    expect(isDestructive('echo rmdir-like', false)).toBe(true)
    expect(isDestructive('ls -la', true)).toBe(true)
  })

  it('confirmNeeded: protected and multi-host or destructive', () => {
    const prod = { name: 'prod', protected: true }
    const staging = { name: 'staging', protected: false }
    for (const count of [1, 2]) {
      for (const destructive of [false, true]) {
        expect(confirmNeeded(prod, count, destructive)).toBe(count > 1 || destructive ? 'prod' : null)
        expect(confirmNeeded(staging, count, destructive)).toBeNull()
        expect(confirmNeeded(null, count, destructive)).toBeNull()
      }
    }
  })

  it('checkConfirm wants the exact name', () => {
    expect(() => checkConfirm(null, undefined)).not.toThrow()
    expect(() => checkConfirm('prod', 'prod')).not.toThrow()
    for (const given of [undefined, '', 'Prod', 'prod ', 'staging']) {
      expect(() => checkConfirm('prod', given)).toThrow(new ProtectError('confirm', 'Type the environment name to confirm'))
    }
  })

  it('protectionFor takes protection from the hosts when the context does not carry it', () => {
    const prod = { id: 'e1', name: 'prod', protected: true }
    const prodEu = { id: 'e2', name: 'prod-eu', protected: true }
    const staging = { id: 'e3', name: 'staging', protected: false }
    expect(protectionFor(null, [])).toBeNull()
    expect(protectionFor(staging, [])).toBe(staging)
    expect(protectionFor(null, [staging])).toBeNull()
    // a host-kind run with no context still needs the name when a host is in prod
    expect(protectionFor(null, [staging, prod, prod])).toBe(prod)
    // an unprotected context does not hide a prod host
    expect(protectionFor(staging, [prod])).toBe(prod)
    // a protected context is the run's environment
    expect(protectionFor(prod, [prod, prodEu])).toBe(prod)
    expect(() => protectionFor(null, [prod, prodEu])).toThrow(
      new ProtectError('multiple-protected', 'These hosts are in more than one protected environment; run one environment at a time'),
    )
    expect(() => protectionFor(staging, [prodEu, prod])).toThrow(ProtectError)
  })
})
