import { describe, expect, it } from 'vitest'
import { color256, parseAnsi, scanAnsi, stripAnsi } from '../../src/renderer/src/ui/ansi'

const ESC = '\u001b'

describe('ansi', () => {
  it('maps 256-colour and RGB codes onto the 16 colours, ignoring backgrounds', () => {
    expect(parseAnsi(`${ESC}[38;5;196merr${ESC}[38;5;244m dim${ESC}[38;2;0;200;0m ok${ESC}[48;5;21m bg${ESC}[0m`)).toEqual([
      { text: 'err', fg: 'bright-red' },
      { text: ' dim', fg: 'bright-black' },
      { text: ' ok bg', fg: 'green' },
    ])
    expect(color256(4)).toBe('blue')
    expect(color256(12)).toBe('bright-blue')
    expect(color256(208)).toBe('yellow')
    expect(color256(232)).toBe('black')
    expect(color256(255)).toBe('white')
    expect(color256(231)).toBe('bright-white')
    expect(color256(300)).toBeUndefined()
  })

  it('drops cursor moves, OSC titles and links, DCS strings, charset picks and lone controls', () => {
    const line = `${ESC}[2J${ESC}[H${ESC}]0;title${ESC}\\${ESC}]8;;https://x${ESC}\\link${ESC}]8;;${ESC}\\ ${ESC}P1$r${ESC}\\${ESC}(Ba\u0008b\u0007c\td\r`
    expect(stripAnsi(line)).toBe('link abc\td\r')
    expect(parseAnsi(line)).toEqual([{ text: 'link abc\td\r' }])
  })

  it('holds back an escape cut off at the end of a piece for the next', () => {
    const first = scanAnsi(`a${ESC}[1;3`)
    expect(first.runs).toEqual([{ text: 'a', at: 0 }])
    expect(first.state).toEqual({ bold: false, carry: `${ESC}[1;3` })
    const next = scanAnsi('4mb', first.state)
    expect(next.runs).toEqual([{ text: 'b', at: 2, fg: 'blue', bold: true }])
    expect(next.state).toEqual({ fg: 'blue', bold: true, carry: '' })
    // A whole line drops what it ends half-way through.
    expect(stripAnsi(`done${ESC}[3`)).toBe('done')
    expect(parseAnsi(`done${ESC}]0;ti`)).toEqual([{ text: 'done' }])
  })
})
