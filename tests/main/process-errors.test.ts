import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { logProcessErrors } from '../../src/main/diagnostics/process-errors'

describe('logProcessErrors', () => {
  it('logs what nothing caught, with the stack when there is one', () => {
    const proc = new EventEmitter()
    const lines: string[] = []
    logProcessErrors(proc, { error: (...a) => void lines.push(a.join(' ')) })
    proc.emit('uncaughtException', new Error('boom'))
    proc.emit('unhandledRejection', 'plain reason')
    expect(lines[0]).toMatch(/^uncaught exception: Error: boom\n\s+at /)
    expect(lines[1]).toBe('unhandled rejection: plain reason')
  })
})
