import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutoLock } from '../../src/main/vault/auto-lock'
import type { LockReason } from '../../src/shared/vault'
import { makeVault } from './vault-helpers'

function setup(init: { idle: number; minutes: number | null; unlocked: boolean }) {
  const s = { ...init }
  const lock = vi.fn((_r: LockReason) => {
    s.unlocked = false
  })
  const auto = new AutoLock({
    idleSeconds: () => s.idle,
    minutes: () => s.minutes,
    isUnlocked: () => s.unlocked,
    lock,
  })
  return { s, lock, auto }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AutoLock', () => {
  it('locks after idle', () => {
    const { s, lock, auto } = setup({ idle: 299, minutes: 5, unlocked: true })
    auto.tick()
    expect(lock).not.toHaveBeenCalled()
    s.idle = 300
    auto.tick()
    auto.tick()
    expect(lock).toHaveBeenCalledTimes(1)
    expect(lock).toHaveBeenCalledWith('idle')

    const never = setup({ idle: 1e9, minutes: null, unlocked: true })
    never.auto.tick()
    expect(never.lock).not.toHaveBeenCalled()

    const locked = setup({ idle: 1e9, minutes: 1, unlocked: false })
    locked.auto.tick()
    expect(locked.lock).not.toHaveBeenCalled()
  })

  it('start ticks every 15 s until stopped', () => {
    vi.useFakeTimers()
    const { s, lock, auto } = setup({ idle: 0, minutes: 1, unlocked: true })
    const stop = auto.start()
    s.idle = 60
    vi.advanceTimersByTime(14_999)
    expect(lock).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(lock).toHaveBeenCalledTimes(1)
    stop()
    s.unlocked = true
    vi.advanceTimersByTime(60_000)
    expect(lock).toHaveBeenCalledTimes(1)
  })

  it('lock on sleep is on by default, persists, and can only be turned off with the vaults open', async () => {
    const f = makeVault()
    await f.vault.setup({ password: 'correct horse', touchId: true })
    expect(f.vault.status().lockOnSleep).toBe(true)
    expect(f.vault.setLockOnSleep(false).lockOnSleep).toBe(false)
    expect(f.vault.lockOnSleep()).toBe(false)
    expect(makeVault({ db: f.db }).vault.status().lockOnSleep).toBe(false)
    expect(f.audit.list({ actions: ['vault.autolock'] })[0]).toMatchObject({ outcome: 'success', details: { lockOnSleep: false } })
    f.vault.setLockOnSleep(true)
    f.vault.lock('manual')
    expect(() => f.vault.setLockOnSleep(false)).toThrow(/locked/i)
    expect(f.vault.setLockOnSleep(true).lockOnSleep).toBe(true)
  })

  it('setAutoLock persists', async () => {
    const f = makeVault()
    await f.vault.setup({ password: 'correct horse', touchId: true })
    expect(f.vault.autoLockMinutes()).toBe(15)
    expect(f.vault.setAutoLock(60).autoLockMinutes).toBe(60)
    expect(f.vault.autoLockMinutes()).toBe(60)
    expect(makeVault({ db: f.db }).vault.status().autoLockMinutes).toBe(60)
    expect(f.audit.list({ actions: ['vault.autolock'] })[0]).toMatchObject({
      outcome: 'success',
      details: { minutes: 60 },
    })
    // Not secret, so allowed while locked.
    f.vault.lock('manual')
    expect(f.vault.setAutoLock(null).autoLockMinutes).toBeNull()
    expect(() => f.vault.setAutoLock(7)).toThrow(/auto-lock/)
  })
})
