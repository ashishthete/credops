import { describe, expect, it } from 'vitest'
import { notesToHtml, notesToText, parseNotes } from '../../src/shared/notes-markdown'

const MD = [
  '## Release 1.4.0',
  '',
  'Ships **checkout retries** and a `--dry-run` flag.',
  'Second line of the same paragraph.',
  '',
  '### Fixes',
  '- Fix **login** loop ([#12](https://github.com/acme/shop/pull/12))',
  '* Bump `node` to 22',
].join('\n')

describe('parseNotes', () => {
  it('parses headings, bullets, bold, code, links', () => {
    expect(parseNotes(MD)).toEqual([
      { kind: 'h', level: 2, spans: [{ t: 'text', v: 'Release 1.4.0' }] },
      {
        kind: 'p',
        spans: [
          { t: 'text', v: 'Ships ' },
          { t: 'bold', v: 'checkout retries' },
          { t: 'text', v: ' and a ' },
          { t: 'code', v: '--dry-run' },
          { t: 'text', v: ' flag. Second line of the same paragraph.' },
        ],
      },
      { kind: 'h', level: 3, spans: [{ t: 'text', v: 'Fixes' }] },
      {
        kind: 'li',
        spans: [
          { t: 'text', v: 'Fix ' },
          { t: 'bold', v: 'login' },
          { t: 'text', v: ' loop (' },
          { t: 'link', v: '#12', href: 'https://github.com/acme/shop/pull/12' },
          { t: 'text', v: ')' },
        ],
      },
      { kind: 'li', spans: [{ t: 'text', v: 'Bump ' }, { t: 'code', v: 'node' }, { t: 'text', v: ' to 22' }] },
    ])
    expect(parseNotes('# Top')).toEqual([{ kind: 'h', level: 2, spans: [{ t: 'text', v: 'Top' }] }])
    expect(parseNotes('an **unclosed bold and `tick')).toEqual([{ kind: 'p', spans: [{ t: 'text', v: 'an **unclosed bold and `tick' }] }])
  })

  it('escapes html in text and attributes', () => {
    const html = notesToHtml(parseNotes('<script>alert("x")</script> **<b>** `<i>` [a"b](https://x.example/?q="><script>)'))
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('"><')
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
    expect(html).toContain('<strong>&lt;b&gt;</strong>')
    expect(html).toContain('<code>&lt;i&gt;</code>')
    expect(html).toContain('href="https://x.example/?q=%22%3E%3Cscript%3E"')
    expect(html).toContain('>a&quot;b</a>')
  })

  it('non-https links become text', () => {
    const blocks = parseNotes('[run](javascript:alert(1)) and [old](http://x.example)')
    expect(blocks).toEqual([{ kind: 'p', spans: [{ t: 'text', v: 'run' }, { t: 'text', v: ' and ' }, { t: 'text', v: 'old' }] }])
    expect(notesToHtml(blocks)).not.toContain('href')
  })

  it('renders html and text', () => {
    const blocks = parseNotes(MD)
    expect(notesToHtml(blocks)).toBe(
      '<h2>Release 1.4.0</h2>\n<p>Ships <strong>checkout retries</strong> and a <code>--dry-run</code> flag. Second line of the same paragraph.</p>\n<h3>Fixes</h3>\n<ul>\n<li>Fix <strong>login</strong> loop (<a href="https://github.com/acme/shop/pull/12">#12</a>)</li>\n<li>Bump <code>node</code> to 22</li>\n</ul>',
    )
    expect(notesToText(blocks)).toBe(
      'Release 1.4.0\n\nShips checkout retries and a --dry-run flag. Second line of the same paragraph.\n\nFixes\n\n- Fix login loop (#12 <https://github.com/acme/shop/pull/12>)\n- Bump node to 22',
    )
  })
})
