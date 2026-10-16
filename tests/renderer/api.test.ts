import { describe, expect, it, vi } from 'vitest'
import { api, cleanIpcErrorMessage } from '../../src/renderer/src/lib/api'

function bridgeRejecting(err: unknown): void {
  ;(window as unknown as { opsdeck: unknown }).opsdeck = { invoke: vi.fn(async () => Promise.reject(err)) }
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

  it('wraps non-Error rejections', async () => {
    bridgeRejecting('boom')
    await expect(api.invoke('audit:verify')).rejects.toThrow(/^boom$/)
  })

  it('passes results through', async () => {
    ;(window as unknown as { opsdeck: unknown }).opsdeck = { invoke: vi.fn(async () => ({ ok: true, count: 1 })) }
    await expect(api.invoke('audit:verify')).resolves.toEqual({ ok: true, count: 1 })
  })
})
