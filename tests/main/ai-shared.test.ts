import { describe, expect, it } from 'vitest'
import { EXPLANATION_SCHEMA, parseExplanation } from '../../src/shared/ai'

const good = {
  summary: 'The container failed its health check.',
  cause: 'Port 8080 is taken.',
  confidence: 'medium',
  steps: ['Check what holds the port'],
  commands: [{ title: 'Who holds 8080', command: 'ss -ltnp | grep 8080', where: 'host', risk: 'read-only' }],
}

describe('parseExplanation', () => {
  it('parses a well-formed explanation', () => {
    expect(parseExplanation(JSON.stringify(good))).toEqual(good)
    expect(EXPLANATION_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false })
    expect(EXPLANATION_SCHEMA.required).toEqual(['summary', 'cause', 'confidence', 'steps', 'commands'])
  })

  it('throws bad-output on malformed or wrong-shaped json', () => {
    for (const raw of ['not json', '[]', JSON.stringify({ ...good, confidence: 'sure' }), JSON.stringify({ ...good, steps: 'x' })]) {
      expect(() => parseExplanation(raw)).toThrow(expect.objectContaining({ code: 'bad-output' }))
    }
  })

  it('caps lengths and drops unsafe commands', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...good.commands[0], title: `c${i}` }))
    const out = parseExplanation(
      JSON.stringify({
        ...good,
        summary: 's'.repeat(5000),
        steps: Array.from({ length: 30 }, () => 'step'),
        commands: [
          { ...good.commands[0], command: 'x'.repeat(2001) },
          { ...good.commands[0], command: 'ls\u0000rm' },
          { ...good.commands[0], risk: 'nuclear' },
          ...many,
        ],
      }),
    )
    expect(out.summary.length).toBeLessThanOrEqual(2000)
    expect(out.steps.length).toBeLessThanOrEqual(12)
    expect(out.commands).toHaveLength(8)
    expect(out.commands.map((c) => c.title)).toEqual(many.slice(0, 8).map((c) => c.title))
  })

  it('drops commands holding control, bidi or zero-width characters and keeps tabs', () => {
    const bad = [
      '\u0001', '\u0008', '\n', '\r', '\u001b', '\u001f', '\u007f', '\u0080', '\u009b', '\u009f',
      '​', '‍', '‎', '‏', '‪', '‮', '⁠', '⁤', '⁦', '⁩', '﻿',
    ]
    const commands = [
      ...bad.map((ch, i) => ({ ...good.commands[0], title: `bad${i}`, command: `ls${ch} -la` })),
      { ...good.commands[0], title: 'tab', command: 'printf "a\\tb"\t| cat' },
      { ...good.commands[0], title: 'unicode', command: 'echo "héllo — 日本"' },
    ]
    const out = parseExplanation(JSON.stringify({ ...good, commands }))
    expect(out.commands.map((c) => c.title)).toEqual(['tab', 'unicode'])
  })
})
