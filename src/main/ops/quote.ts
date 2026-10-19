/**
 * Shell quoting and snippet templates: the security core of Ops. Pure, no ssh imports.
 *
 * An SSH exec request carries one string that the host's login shell parses. Quoting is POSIX
 * (sh — bash/POSIX, bash, zsh, dash); fish and csh/tcsh read quotes differently and are not supported.
 * OpsDeck builds a command in exactly two ways:
 * - argv: `shJoin(argv)`, each element one word on the remote side whatever it contains;
 * - template: the snippet's script is trusted text written by the user, and only variable values are
 *   untrusted. Each value is substituted as one `shQuote`d word, and only where the shell reads that
 *   word literally: unquoted, at the top level or inside `$( )`.
 *
 * What quoting can't do, and stays the script author's job:
 * - A value is one word, but the program that receives it may still read it as an option (`-rf`,
 *   `--force`). Write `-- {{file}}` where it matters.
 * - A value handed to something that evaluates its argument as code, a variable name or a subscript
 *   runs as such: `eval`, `sh -c`, `bash -c`, `let`, `declare -i`, `typeset`, `local`, `export`,
 *   `readonly`, `unset`, `read`, `read -t`, `printf -v`, `printf %d`, `shift`, `ulimit -n`,
 *   zsh glob qualifiers. That is the same as any trusted script text. So is `n={{n}}; echo $((n+1))`,
 *   which evaluates the value at runtime, and a `typeset -A` / `declare -A` literal built at runtime.
 */
import { MAX_SCRIPT, MAX_VARIABLE_VALUE, MAX_VARIABLES, VARIABLE_NAME } from '../../shared/ops'

export class TemplateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateError'
  }
}

/** Left unquoted: safe characters, and never a first character that zsh or the tilde rules expand (= ~ # % -). */
const SAFE_WORD = /^[A-Za-z0-9_@+:,./][A-Za-z0-9_@%+=:,./-]*$/

export function shQuote(s: string): string {
  if (s.includes('\0')) throw new TypeError("a shell word can't contain NUL")
  if (s === '') return "''"
  if (SAFE_WORD.test(s)) return s
  return `'${s.replaceAll("'", `'\\''`)}'`
}

export function shJoin(argv: readonly string[]): string {
  return argv.map(shQuote).join(' ')
}

/** C0 and C1 controls and DEL, except tab and newline. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

export function checkValue(name: string, value: string): string {
  if (CONTROL.test(value)) throw new TemplateError(`variable ${name} has a control character`)
  if (value.length > MAX_VARIABLE_VALUE) throw new TemplateError(`variable ${name} is longer than ${MAX_VARIABLE_VALUE} characters`)
  return value
}

export interface ParsedTemplate {
  parts: ({ text: string } | { variable: string })[]
  /** First-use order. */
  variables: string[]
}

/**
 * Lexer frames. `top` and `subshell` ($( )) are the only places a placeholder may sit, and only when no
 * enclosing frame is quoted or evaluated: a substitution inside double quotes is still inside them.
 * `arith` is $(( )), (( )) and $[ ]; `cond` is [[ ]]; `param` is ${ }.
 */
type FrameKind = 'top' | 'subshell' | 'backtick' | 'single' | 'double' | 'dollarSingle' | 'param' | 'arith' | 'cond'

interface Frame {
  kind: FrameKind
  /** Open ( in a subshell or $(( )), [ in $[ ], { in ${ }. */
  depth: number
  /** arith only: what closes it. */
  close: ')' | ']'
  /** top and subshell only: unclosed [ of an array subscript the shell evaluates, with nesting. */
  bracket: number
  /** top and subshell only: open ( of an array assignment `NAME=(…)` or `NAME+=(…)`. */
  assign: number
  /** top and subshell only: where the current word began, or -1 between words. */
  wordBegin: number
  /** top and subshell only: an earlier word of this simple command is a declaration builtin. */
  declaration: boolean
}

const QUOTED = (name: string) => `{{${name}}} is inside quotes; remove them, OpsDeck quotes values itself`
const IN_BACKTICKS = (name: string) => `{{${name}}} is inside backticks; use $( ) instead`
const IN_ARITH = (name: string) => `{{${name}}} can't be used in arithmetic or [[ ]]; pass it through a variable and validate it`
const IN_PARAM = (name: string) => `{{${name}}} can't be used inside \${ }; assign it to a variable first`
const HEREDOC = "a script with variables can't use a here-document"

/** Constructs that sh, bash, zsh or dash read differently; fine on their own, refused next to a variable. */
const AMBIGUOUS = {
  case: "a script with variables can't use case inside $( ); move the case out or use if",
  quoteInParam: `a script with variables can't put ' inside "\${ }"`,
  ansiQuote: "a script with variables can't use \\' inside $'…'",
  arithParen: "a script with variables can't open $(( or (( as a subshell; put a space between the parentheses",
  doubleParen: "a script with variables can't use (( arithmetic; pass the value through a variable and validate it",
  doubleBracket: "a script with variables can't use [[ ]]; use case or pass the value through a variable and validate it",
  commentText: 'a script with variables can only have comments made of letters, digits, spaces and . , : _ / = + -',
  arrayLiteral: "a script with variables can't use [ inside an array assignment ( ); assign the elements one by one",
  globQualifier: "a script with variables can't put ( right after a word (a zsh glob qualifier or extglob group); put a space before it",
  declarationSubscript: "a script with variables can't pass declare, typeset, local, export or readonly a name with [ before its =",
  lineContinuation: "a script with variables can't use a backslash-newline line continuation; join the line or end it",
  unterminated: 'a script with variables has an unterminated quote, bracket or substitution',
} as const

const BLANK = new Set([' ', '\t'])
/** Ends a word in unquoted shell text. */
const BOUNDARY = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>'])
/** What a comment in a script with variables may contain after the `#`. */
const COMMENT_TEXT = /^[A-Za-z0-9 \t.,:_/=+-]*$/
/** A character before `[` that makes it an array subscript the shell evaluates, not a test or glob bracket. */
const NAME_BEFORE_BRACKET = /[A-Za-z0-9_\]}]/
/** Special parameters zsh subscripts like a name when they follow `$` (`$@[`, `$#[`). */
const SPECIAL_BEFORE_BRACKET = /[@*#?$!-]/
/** Builtins that read an argument's `NAME[…]` as a subscript after quote removal. */
const DECLARATIONS = new Set(['declare', 'typeset', 'local', 'export', 'readonly'])
/** Ends a simple command; a blank or redirection only ends a word. */
const COMMAND_END = new Set(['\n', ';', '&', '|', '(', ')'])
const DOUBLE_ESCAPES = new Set(['$', '`', '"', '\\', '\n'])
const PLACEHOLDER = /\{\{[ \t]*([^{}\s]*)[ \t]*\}\}/y

function position(s: string, at: number): string {
  const before = s.slice(0, at)
  const line = before.split('\n').length
  return `line ${line}, column ${at - before.lastIndexOf('\n')}`
}

/** Reads the placeholder at `at`. The text is never echoed unless it is a valid name: it may be anything. */
function readPlaceholder(s: string, at: number): { name: string; end: number } {
  PLACEHOLDER.lastIndex = at
  const m = PLACEHOLDER.exec(s)
  if (!m || m[1] === '') {
    throw new TemplateError(`the {{ at ${position(s, at)} isn't a placeholder; write {{name}}, or put a space between the braces`)
  }
  if (!VARIABLE_NAME.test(m[1])) {
    throw new TemplateError(`the placeholder at ${position(s, at)} has an invalid name; use lower-case letters, digits and _`)
  }
  return { name: m[1], end: at + m[0].length }
}

/** Why a placeholder can't sit at the innermost frame of `stack`, or null when it can. */
function contextError(stack: readonly Frame[], name: string): string | null {
  for (let k = stack.length - 1; k >= 0; k--) {
    const f = stack[k]
    switch (f.kind) {
      case 'single':
      case 'double':
      case 'dollarSingle':
        return QUOTED(name)
      case 'backtick':
        return IN_BACKTICKS(name)
      case 'arith':
      case 'cond':
        return IN_ARITH(name)
      case 'param':
        return IN_PARAM(name)
      case 'top':
      case 'subshell':
        if (f.bracket > 0) return IN_ARITH(name)
    }
  }
  return null
}

/**
 * Splits a snippet script into text and `{{name}}` placeholders, refusing any placeholder whose value
 * the shell would not read as one literal word. One pass with a frame stack; no regex over the script.
 */
export function parseTemplate(script: string): ParsedTemplate {
  const s = script
  if (s.length > MAX_SCRIPT) throw new TemplateError(`the script is longer than ${MAX_SCRIPT} characters`)

  const frame = (kind: FrameKind, close: ')' | ']' = ')'): Frame => ({
    kind,
    depth: 0,
    close,
    bracket: 0,
    assign: 0,
    wordBegin: -1,
    declaration: false,
  })
  const stack: Frame[] = [frame('top')]
  const parts: ParsedTemplate['parts'] = []
  const variables: string[] = []
  const heredocs: { delimiter: string; stripTabs: boolean }[] = []
  let hasHeredoc = false
  let ambiguity: keyof typeof AMBIGUOUS | null = null
  let textStart = 0
  let wordStart = true
  let i = 0

  const push = (f: Frame): void => {
    stack.push(f)
  }
  const pop = (): void => {
    stack.pop()
    wordStart = false
  }
  const inside = (kind: FrameKind): boolean => stack.some((f) => f.kind === kind)

  /** At `c`, which ends a word in a command frame: notes a declaration builtin, and a command's end. */
  const endWord = (f: Frame, c: string): void => {
    if (f.wordBegin >= 0 && DECLARATIONS.has(s.slice(f.wordBegin, i).replace(/['"\\]/g, ''))) f.declaration = true
    f.wordBegin = -1
    if (COMMAND_END.has(c)) f.declaration = false
  }

  /** At `<<` (not `<<<`): records it, and in a command frame reads the delimiter so its body can be skipped. */
  const hereDocument = (f: Frame): void => {
    hasHeredoc = true
    let j = i + 2
    const stripTabs = s[j] === '-'
    if (stripTabs) j++
    if (f.kind !== 'top' && f.kind !== 'subshell') {
      i = j
      return
    }
    while (BLANK.has(s[j])) j++
    const start = j
    let delimiter = ''
    while (j < s.length && !BOUNDARY.has(s[j]) && s[j] !== '\n') {
      const c = s[j]
      if (c === "'" || c === '"') {
        const k = s.indexOf(c, j + 1)
        const end = k === -1 ? s.length : k
        const quoted = s.slice(j + 1, end)
        delimiter += c === '"' ? quoted.replaceAll('\\', '') : quoted
        j = end + 1
      } else if (c === '\\') {
        delimiter += s[j + 1] ?? ''
        j += 2
      } else {
        delimiter += c
        j++
      }
    }
    if (s.slice(start, j).includes('{{')) throw new TemplateError(HEREDOC)
    if (delimiter !== '') heredocs.push({ delimiter, stripTabs })
    i = Math.min(j, s.length)
    wordStart = false
  }

  /** After the newline that ends a command line: skips the pending here-document bodies. */
  const skipBodies = (): void => {
    for (const h of heredocs) {
      while (i < s.length) {
        const nl = s.indexOf('\n', i)
        const line = s.slice(i, nl === -1 ? s.length : nl)
        if (line.includes('{{')) throw new TemplateError(HEREDOC)
        i = nl === -1 ? s.length : nl + 1
        if ((h.stripTabs ? line.replace(/^\t+/, '') : line) === h.delimiter) break
      }
    }
    heredocs.length = 0
  }

  /** `$` followed by something that opens a frame; returns false for a plain `$`. */
  const dollar = (quoted: boolean): boolean => {
    const next = s[i + 1]
    if (s.startsWith('{{', i + 1)) return false // a placeholder right after $ is refused below
    if (next === '(' && s[i + 2] === '(') {
      push(frame('arith'))
      i += 3
    } else if (next === '(') {
      push(frame('subshell'))
      i += 2
      wordStart = true
    } else if (next === '[') {
      push(frame('arith', ']'))
      i += 2
    } else if (next === '{') {
      push(frame('param'))
      i += 2
    } else if (!quoted && next === "'") {
      push(frame('dollarSingle'))
      i += 2
    } else if (!quoted && next === '"') {
      push(frame('double'))
      i += 2
    } else {
      return false
    }
    return true
  }

  /** A backslash escapes the next character; one in front of a placeholder quotes it. */
  const backslash = (escapes: boolean): void => {
    if (s.startsWith('{{', i + 1)) throw new TemplateError(QUOTED(readPlaceholder(s, i + 1).name))
    i += escapes ? 2 : 1
  }

  while (i < s.length) {
    const f = stack[stack.length - 1]
    const c = s[i]

    if (c === '{' && s[i + 1] === '{') {
      const { name, end } = readPlaceholder(s, i)
      const error = contextError(stack, name)
      if (error) throw new TemplateError(error)
      if (s[i - 1] === '$') throw new TemplateError(`{{${name}}} can't follow a $`)
      // A declaration builtin reads `'a'[…]` as a subscript once quotes are removed, so any [ before the
      // word's first = counts, quoted or not; so does one in an enclosing word (`'a'[$(echo {{n}})]`).
      if (wordStart) f.wordBegin = i
      for (const g of stack) {
        if (!g.declaration || g.wordBegin < 0) continue
        const head = s.slice(g.wordBegin, i)
        const bracket = head.indexOf('[')
        const equals = head.indexOf('=')
        if (bracket !== -1 && (equals === -1 || bracket < equals)) ambiguity ??= 'declarationSubscript'
      }
      if (!variables.includes(name)) {
        if (variables.length === MAX_VARIABLES) throw new TemplateError(`a script can have at most ${MAX_VARIABLES} variables`)
        variables.push(name)
      }
      if (i > textStart) parts.push({ text: s.slice(textStart, i) })
      parts.push({ variable: name })
      i = textStart = end
      wordStart = false
      continue
    }

    switch (f.kind) {
      case 'single':
        if (c === "'") pop()
        i++
        continue
      case 'dollarSingle':
        if (c === '\\') {
          if (s[i + 1] === "'") ambiguity ??= 'ansiQuote'
          backslash(true)
        } else {
          if (c === "'") pop()
          i++
        }
        continue
      case 'backtick':
        // The shell ends backticks at the first unescaped one, whatever quotes sit in between.
        if (c === '\\') {
          if (s[i + 1] === '\n') ambiguity ??= 'lineContinuation'
          backslash(true)
        } else if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') hereDocument(f)
        else {
          if (c === '`') pop()
          i++
        }
        continue
      case 'double':
        if (c === '\\') {
          if (s[i + 1] === '\n') ambiguity ??= 'lineContinuation'
          backslash(DOUBLE_ESCAPES.has(s[i + 1]))
        }
        else if (c === '"') {
          pop()
          i++
        } else if (c === '`') {
          push(frame('backtick'))
          i++
        } else if (!(c === '$' && dollar(true))) i++
        continue
    }

    // Unquoted frames: top, subshell, cond, arith, param.
    const command = f.kind === 'top' || f.kind === 'subshell'
    if (command && wordStart && !BOUNDARY.has(c)) f.wordBegin = i
    if (c === '\\') {
      const before: boolean = wordStart
      if (s[i + 1] === '\n') ambiguity ??= 'lineContinuation'
      backslash(true)
      if (s[i - 1] === '\n') wordStart = before // a line continuation joins the word around it
      else wordStart = false
      continue
    }
    if (c === "'") {
      if (f.kind === 'param' && inside('double')) {
        ambiguity ??= 'quoteInParam'
        i++
      } else {
        push(frame('single'))
        i++
      }
      wordStart = false
      continue
    }
    if (c === '"') {
      push(frame('double'))
      i++
      wordStart = false
      continue
    }
    if (c === '`') {
      push(frame('backtick'))
      i++
      wordStart = false
      continue
    }
    if (c === '$' && dollar(false)) continue
    if (c === '<' && s[i + 1] === '<') {
      if (command) endWord(f, c)
      if (s[i + 2] === '<') {
        i += 3
        wordStart = true
      } else hereDocument(f)
      continue
    }

    if (f.kind === 'arith') {
      if (c === (f.close === ')' ? '(' : '[')) f.depth++
      else if (c === f.close) {
        if (f.depth > 0) f.depth--
        else if (f.close === ']') pop()
        else if (s[i + 1] === ')') {
          pop()
          i++
        } else {
          ambiguity ??= 'arithParen'
          pop()
        }
      }
      i++
      continue
    }
    if (f.kind === 'param') {
      if (c === '{') f.depth++
      else if (c === '}') {
        if (f.depth > 0) f.depth--
        else pop()
      }
      i++
      continue
    }

    // cond, top, subshell
    if (wordStart && f.kind === 'cond' && s.startsWith(']]', i) && (i + 2 === s.length || BOUNDARY.has(s[i + 2]))) {
      pop()
      i += 2
      continue
    }
    if (wordStart && c === '#' && f.kind !== 'cond') {
      const nl = s.indexOf('\n', i)
      const comment = s.slice(i, nl === -1 ? s.length : nl)
      // Shells with interactive_comments off (zsh -i) read # literally, so comment text keeps
      // parsing as code; allow only plain prose rather than chase each construct.
      if (!COMMENT_TEXT.test(comment.slice(1))) ambiguity ??= 'commentText'
      i = nl === -1 ? s.length : nl
      continue
    }
    if (command) {
      // `[[` and `((` open code the moment they appear, after a reserved word or `(` just as at a word
      // start (`for((`, `if((`, `then((`, `[[(`); refuse the token anywhere, not only where it is clean.
      if (s.startsWith('[[', i)) {
        ambiguity ??= 'doubleBracket'
        push(frame('cond'))
        i += 2
        continue
      }
      if (s.startsWith('((', i)) {
        ambiguity ??= 'doubleParen'
        push(frame('arith'))
        i += 2
        continue
      }
      if (wordStart && f.kind === 'subshell' && /^case[ \t\n]/.test(s.slice(i, i + 5))) ambiguity ??= 'case'
      // A ( glued to a word is a zsh glob qualifier (*(e:…:) runs code, in any position and with any
      // delimiter) or an extglob group. Allowed: NAME=( and NAME+=( arrays, and NAME() definitions.
      // $( <( >( and =( never get here glued to a word: $ opens its own frame, < > end the word.
      if (c === '(' && !wordStart && s[i - 1] !== '=' && s[i + 1] !== ')') ambiguity ??= 'globQualifier'
    }
    if (c === '(' && f.kind === 'subshell') f.depth++
    if (c === ')' && f.kind === 'subshell') {
      if (f.depth > 0) f.depth--
      else {
        if (f.bracket > 0) ambiguity ??= 'unterminated'
        pop()
        i++
        continue
      }
    }
    if (command) {
      // A subscript is a `[` stuck to a name (`a[`, `$x[`, `a[0][`); bash keeps it open across blanks,
      // operators and newlines, so it closes only on its matching `]`. A bare `[` (the test command)
      // or a `[...]` glob is not a subscript. Inside an array assignment `NAME=(…)` any `[` is refused.
      if (c === '[' && f.assign > 0) ambiguity ??= 'arrayLiteral'
      const prev = s[i - 1] ?? ''
      const subscript = NAME_BEFORE_BRACKET.test(prev) || (s[i - 2] === '$' && SPECIAL_BEFORE_BRACKET.test(prev))
      if (c === '[' && (f.bracket > 0 || subscript)) f.bracket++
      else if (c === ']' && f.bracket > 0) f.bracket--
      if (c === '(' && (f.assign > 0 || s[i - 1] === '=')) f.assign++
      else if (c === ')' && f.assign > 0) f.assign--
    }
    if (command && BOUNDARY.has(c)) endWord(f, c)
    wordStart = BOUNDARY.has(c)
    i++
    if (c === '\n' && command && heredocs.length > 0) skipBodies()
  }

  if (i > textStart) parts.push({ text: s.slice(textStart) })
  if (variables.length > 0) {
    if (hasHeredoc) throw new TemplateError(HEREDOC)
    if (ambiguity) throw new TemplateError(AMBIGUOUS[ambiguity])
    if (stack.length > 1 || stack[0].bracket > 0) throw new TemplateError(AMBIGUOUS.unterminated)
  }
  return { parts, variables }
}

/** Substitutes each placeholder with its value as one quoted word; a missing value falls back to its default. */
export function renderTemplate(
  t: ParsedTemplate,
  values: Record<string, string>,
  defaults: Record<string, string | null>,
): string {
  let out = ''
  for (const part of t.parts) {
    if ('text' in part) {
      out += part.text
      continue
    }
    const name = part.variable
    const value = Object.hasOwn(values, name) ? values[name] : Object.hasOwn(defaults, name) ? defaults[name] : null
    if (typeof value !== 'string') throw new TemplateError(`variable ${name} needs a value`)
    out += shQuote(checkValue(name, value))
  }
  return out
}
