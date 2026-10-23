import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initialWindowState, loadWindowState, parseWindowState, saveWindowState } from '../../src/main/window-state'

// A 14" MacBook Pro's work area below the menu bar.
const laptop = { x: 0, y: 38, width: 1512, height: 944 }
const external = { x: 1512, y: 0, width: 2560, height: 1415 }

describe('parseWindowState', () => {
  it('reads a saved state', () => {
    const s = { bounds: { x: 10, y: 50, width: 1200, height: 800 }, maximized: false, fullScreen: true }
    expect(parseWindowState(s)).toEqual(s)
  })

  it('rejects anything malformed', () => {
    for (const raw of [null, 'x', {}, { bounds: { x: 0, y: 0, width: '1', height: 1 } }, { bounds: { x: 0, y: 0, width: Infinity, height: 1 } }]) {
      expect(parseWindowState(raw)).toBeNull()
    }
  })
})

describe('initialWindowState', () => {
  it('fills the work area on first launch', () => {
    expect(initialWindowState(null, [laptop], laptop)).toEqual({ bounds: laptop, maximized: false, fullScreen: false })
  })

  it('reopens where it was left', () => {
    const saved = { bounds: { x: 1600, y: 100, width: 1800, height: 1100 }, maximized: true, fullScreen: false }
    expect(initialWindowState(saved, [laptop, external], laptop)).toEqual(saved)
  })

  it('moves back to the main display when its display is gone', () => {
    const saved = { bounds: { x: 1600, y: 100, width: 1800, height: 1100 }, maximized: false, fullScreen: true }
    expect(initialWindowState(saved, [laptop], laptop)).toEqual({ bounds: laptop, maximized: false, fullScreen: true })
  })

  it('shrinks a saved size that no longer fits its display', () => {
    const saved = { bounds: { x: 0, y: 38, width: 2400, height: 1400 }, maximized: false, fullScreen: false }
    expect(initialWindowState(saved, [laptop], laptop).bounds).toEqual(laptop)
  })

  it('never opens below the minimum size', () => {
    const saved = { bounds: { x: 20, y: 60, width: 300, height: 200 }, maximized: false, fullScreen: false }
    expect(initialWindowState(saved, [laptop], laptop).bounds).toEqual({ x: 20, y: 60, width: 960, height: 640 })
  })
})

describe('loadWindowState / saveWindowState', () => {
  let dir = ''
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('round-trips through the file, and a missing or corrupt file reads as none', () => {
    dir = mkdtempSync(join(tmpdir(), 'credops-win-'))
    const file = join(dir, 'window-state.json')
    expect(loadWindowState(file)).toBeNull()
    const s = { bounds: { x: 1, y: 2, width: 1000, height: 700 }, maximized: true, fullScreen: false }
    saveWindowState(file, s)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(s)
    expect(loadWindowState(file)).toEqual(s)
    writeFileSync(file, '{not json')
    expect(loadWindowState(file)).toBeNull()
  })
})
