import { describe, expect, it } from 'vitest'
import { windowOptions } from '../../src/main/window'

describe('windowOptions', () => {
  it('creates a locked-down window', () => {
    const o = windowOptions('/p/preload.js')
    expect(o.webPreferences).toMatchObject({
      preload: '/p/preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    })
    expect(o.backgroundColor).toBe('#0b0d12')
    expect(o.titleBarStyle).toBe('hiddenInset')
  })
})
