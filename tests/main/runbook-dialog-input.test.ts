import { describe, expect, it } from 'vitest'
import { asRunbookSaveInput } from '../../src/main/ipc/validators'
import { runbookInput, type Runbook } from '../../src/shared/runbooks'

describe('runbook dialog save payload', () => {
  it('a stored runbook turns into an input the real IPC validator accepts', () => {
    const stored: Runbook = {
      id: '33333333-3333-4333-8333-333333333333',
      environmentId: '11111111-1111-4111-8111-111111111111',
      name: 'Tail',
      description: '',
      targetServiceIds: ['22222222-2222-4222-8222-222222222222'],
      items: [{ type: 'builtin', builtin: 'logs', tail: 100 }],
      params: [],
      lock: false,
      notify: false,
      createdAt: '2026-10-16T09:00:00.000Z',
      updatedAt: '2026-10-16T09:00:00.000Z',
    }
    expect(() => asRunbookSaveInput(stored, 'input')).toThrow()
    expect(() => asRunbookSaveInput({ ...runbookInput(stored), id: stored.id }, 'input')).not.toThrow()
  })
})
