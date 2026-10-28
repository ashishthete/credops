import { describe, expect, it, vi } from 'vitest'
import { api, cleanIpcErrorMessage, errorCode } from '../../src/renderer/src/lib/api'
import { errorText } from '../../src/renderer/src/ui/common'
import { encodeIpcError } from '../../src/shared/ipc-error'

function bridgeRejecting(err: unknown): void {
  ;(window as unknown as { credops: unknown }).credops = { invoke: vi.fn(async () => Promise.reject(err)) }
}

describe('cleanIpcErrorMessage', () => {
  it('strips the Electron remote-method prefix', () => {
    expect(cleanIpcErrorMessage("Error invoking remote method 'audit:list': Error: disk full")).toBe('disk full')
    expect(cleanIpcErrorMessage("Error invoking remote method 'audit:list': TypeError: bad")).toBe('TypeError: bad')
    expect(cleanIpcErrorMessage('plain message')).toBe('plain message')
  })
})

describe('api.invoke', () => {
  it('rethrows IPC failures with a clean message', async () => {
    bridgeRejecting(new Error("Error invoking remote method 'audit:verify': Error: untrusted sender"))
    await expect(api.invoke('audit:verify')).rejects.toThrow(/^untrusted sender$/)
  })

  it("rebuilds main's code as .code and keeps the message as main wrote it", async () => {
    bridgeRejecting(new Error(`Error invoking remote method 'release:start': Error: ${encodeIpcError('PLAYBOOK_CHANGED', 'The playbook changed. Review it again.')}`))
    const err = await api.invoke('audit:verify').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('The playbook changed. Review it again.')
    expect(errorCode(err)).toBe('PLAYBOOK_CHANGED')
    // What the user reads never shows the code, however the error is turned into text.
    expect(errorText(err)).toBe('The playbook changed. Review it again.')
    expect(cleanIpcErrorMessage(`Error invoking remote method 'x': Error: ${encodeIpcError('confirm', 'Type it')}`)).toBe('Type it')
  })

  it('an error without a code has none, even when its text looks like one part-way through', async () => {
    bridgeRejecting(new Error("Error invoking remote method 'audit:verify': Error: disk full [code:X] y"))
    const err = await api.invoke('audit:verify').catch((e: unknown) => e)
    expect((err as Error).message).toBe('disk full [code:X] y')
    expect(errorCode(err)).toBeUndefined()
  })

  it('wraps non-Error rejections', async () => {
    bridgeRejecting('boom')
    await expect(api.invoke('audit:verify')).rejects.toThrow(/^boom$/)
  })

  it('passes results through', async () => {
    ;(window as unknown as { credops: unknown }).credops = { invoke: vi.fn(async () => ({ ok: true, count: 1 })) }
    await expect(api.invoke('audit:verify')).resolves.toEqual({ ok: true, count: 1 })
  })
})
