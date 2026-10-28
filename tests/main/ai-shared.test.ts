import { describe, expect, it } from 'vitest'
import { commandRisk, EXPLANATION_SCHEMA, parseExplanation, UNSAFE_COMMAND_CHARS } from '../../src/shared/ai'

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

  it('drops a command holding a control, bidi or zero-width character, so what runs is what is shown', () => {
    const hidden = [
      'ls\tx', 'ls\nrm -rf /', 'ls\rrm -rf /', 'ls\u0015rm', 'ls\u007f', 'ls\bx', 'ls\u001b[2K', 'ls\u0085', 'ls\u009b',
      'ls ‮rm', 'ls ‪', 'ls ⁦x⁩', 'ls​', 'ls‏', 'ls⁠', 'ls﻿',
    ]
    const out = parseExplanation(JSON.stringify({ ...good, commands: [...hidden.map((command) => ({ ...good.commands[0], command })), good.commands[0]] }))
    expect(out.commands).toEqual(good.commands)
    for (const c of hidden) expect(UNSAFE_COMMAND_CHARS.test(c)).toBe(true)
    // Printable non-ASCII stays.
    expect(UNSAFE_COMMAND_CHARS.test('grep "café ✓" /var/log/app.log')).toBe(false)
  })

  it('raises a command matching the destructive pattern to destructive, and never lowers a risk', () => {
    const out = parseExplanation(
      JSON.stringify({
        ...good,
        commands: [
          { ...good.commands[0], command: 'rm -rf /var/lib/app', risk: 'read-only' },
          { ...good.commands[0], command: 'docker compose down', risk: 'changes-state' },
          { ...good.commands[0], command: 'ls -la', risk: 'destructive' },
          { ...good.commands[0], command: 'systemctl status nginx', risk: 'read-only' },
        ],
      }),
    )
    expect(out.commands.map((c) => c.risk)).toEqual(['destructive', 'destructive', 'destructive', 'read-only'])
    expect(commandRisk('reboot', 'read-only')).toBe('destructive')
    expect(commandRisk('uptime', 'changes-state')).toBe('changes-state')
  })
})
