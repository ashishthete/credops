import { describe, expect, it } from 'vitest'
import { devRendererUrl, shouldAllowNavigation, windowOptions } from '../../src/main/window'

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

describe('shouldAllowNavigation', () => {
  const app = 'file:///app/out/renderer/index.html#/audit'

  it('allows only the loaded app document', () => {
    expect(shouldAllowNavigation(app, 'file:///app/out/renderer/index.html#/settings')).toBe(true)
    expect(shouldAllowNavigation(app, 'file:///app/out/renderer/index.html')).toBe(true)
    expect(shouldAllowNavigation('http://localhost:5173/#/x', 'http://localhost:5173/#/y')).toBe(true)
  })

  it('blocks dropped files, other pages and junk', () => {
    expect(shouldAllowNavigation(app, 'file:///Users/me/Desktop/secret.pem')).toBe(false)
    expect(shouldAllowNavigation(app, 'https://evil.test/')).toBe(false)
    expect(shouldAllowNavigation(app, 'file:///app/out/renderer/index.html?x=1')).toBe(false)
    expect(shouldAllowNavigation('http://localhost:5173/', 'http://localhost:5174/')).toBe(false)
    expect(shouldAllowNavigation(app, 'not a url')).toBe(false)
    expect(shouldAllowNavigation('', 'file:///app/out/renderer/index.html')).toBe(false)
  })
})

describe('devRendererUrl', () => {
  it('honours ELECTRON_RENDERER_URL only when unpackaged', () => {
    const env = { ELECTRON_RENDERER_URL: 'http://localhost:5173' }
    expect(devRendererUrl(false, env)).toBe('http://localhost:5173')
    expect(devRendererUrl(true, env)).toBeUndefined()
    expect(devRendererUrl(false, {})).toBeUndefined()
    expect(devRendererUrl(false, { ELECTRON_RENDERER_URL: '' })).toBeUndefined()
  })
})
