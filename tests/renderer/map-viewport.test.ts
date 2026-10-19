import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_VIEWPORTS,
  MAX_ZOOM,
  MIN_ZOOM,
  VIEWPORT_KEY,
  clearPins,
  loadViewport,
  pinsStore,
  saveViewport,
  setPin,
} from '../../src/renderer/src/map/viewport'

beforeEach(() => {
  localStorage.clear()
  pinsStore.set({})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('viewport storage', () => {
  it('round-trips per scope', () => {
    saveViewport('all', { x: 10, y: -20, zoom: 0.8 })
    saveViewport('p:p1', { x: 1, y: 2, zoom: 1.5 })
    expect(loadViewport('all')).toEqual({ x: 10, y: -20, zoom: 0.8 })
    expect(loadViewport('p:p1')).toEqual({ x: 1, y: 2, zoom: 1.5 })
    expect(loadViewport('e:nowhere')).toBeNull()
    expect(JSON.parse(localStorage.getItem(VIEWPORT_KEY)!)).toEqual({
      all: { x: 10, y: -20, zoom: 0.8 },
      'p:p1': { x: 1, y: 2, zoom: 1.5 },
    })
  })

  it('evicts the oldest past 32 scopes', () => {
    expect(MAX_VIEWPORTS).toBe(32)
    for (let i = 0; i < MAX_VIEWPORTS; i++) saveViewport(`e:${i}`, { x: i, y: i, zoom: 1 })
    // Writing e:0 again makes it the newest, so e:1 is the oldest now.
    saveViewport('e:0', { x: 100, y: 0, zoom: 1 })
    saveViewport('e:new', { x: 0, y: 0, zoom: 1 })
    expect(loadViewport('e:1')).toBeNull()
    expect(loadViewport('e:0')).toEqual({ x: 100, y: 0, zoom: 1 })
    expect(loadViewport('e:new')).toEqual({ x: 0, y: 0, zoom: 1 })
    expect(Object.keys(JSON.parse(localStorage.getItem(VIEWPORT_KEY)!))).toHaveLength(MAX_VIEWPORTS)
  })

  it('survives throwing storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(loadViewport('all')).toBeNull()
    expect(() => saveViewport('all', { x: 0, y: 0, zoom: 1 })).not.toThrow()
  })

  it('ignores corrupt JSON', () => {
    localStorage.setItem(VIEWPORT_KEY, '{not json')
    expect(loadViewport('all')).toBeNull()
    saveViewport('all', { x: 3, y: 4, zoom: 1 })
    expect(loadViewport('all')).toEqual({ x: 3, y: 4, zoom: 1 })

    // Valid JSON of the wrong shape reads as nothing stored, and bad entries are dropped on the next write.
    localStorage.setItem(VIEWPORT_KEY, JSON.stringify({ all: { x: 'a', y: 0, zoom: 1 }, 'p:p1': null }))
    expect(loadViewport('all')).toBeNull()
    expect(loadViewport('p:p1')).toBeNull()
    saveViewport('e:e1', { x: 0, y: 0, zoom: 2 })
    expect(JSON.parse(localStorage.getItem(VIEWPORT_KEY)!)).toEqual({ 'e:e1': { x: 0, y: 0, zoom: 2 } })
    localStorage.setItem(VIEWPORT_KEY, '[1,2]')
    expect(loadViewport('0')).toBeNull()
  })

  it('rejects a zoom of zero or less and clamps the rest to the canvas range', () => {
    expect([MIN_ZOOM, MAX_ZOOM]).toEqual([0.2, 2])
    localStorage.setItem(
      VIEWPORT_KEY,
      JSON.stringify({
        zero: { x: 0, y: 0, zoom: 0 },
        negative: { x: 0, y: 0, zoom: -1 },
        huge: { x: 5, y: 6, zoom: 1e6 },
        tiny: { x: 1, y: 1, zoom: 0.001 },
      }),
    )
    expect(loadViewport('zero')).toBeNull()
    expect(loadViewport('negative')).toBeNull()
    expect(loadViewport('huge')).toEqual({ x: 5, y: 6, zoom: 2 })
    expect(loadViewport('tiny')).toEqual({ x: 1, y: 1, zoom: 0.2 })

    // Saving applies the same rules.
    saveViewport('all', { x: 0, y: 0, zoom: 0 })
    expect(loadViewport('all')).toBeNull()
    saveViewport('all', { x: 0, y: 0, zoom: 40 })
    expect(JSON.parse(localStorage.getItem(VIEWPORT_KEY)!).all).toEqual({ x: 0, y: 0, zoom: 2 })
  })
})

describe('pins store', () => {
  it('keeps pins per scope and clears one scope at a time', () => {
    const seen = vi.fn()
    const off = pinsStore.subscribe(seen)
    setPin('all', 'e:e1', { x: 5, y: 6 })
    setPin('all', 'p:p1', { x: 1, y: 2 })
    setPin('e:e1', 'e:e1/h:h1', { x: 30, y: 50 })
    expect(pinsStore.get()).toEqual({
      all: { 'e:e1': { x: 5, y: 6 }, 'p:p1': { x: 1, y: 2 } },
      'e:e1': { 'e:e1/h:h1': { x: 30, y: 50 } },
    })
    clearPins('all')
    expect(pinsStore.get()).toEqual({ 'e:e1': { 'e:e1/h:h1': { x: 30, y: 50 } } })
    expect(seen).toHaveBeenCalledTimes(4)
    // Clearing a scope with no pins changes nothing and notifies no one.
    clearPins('all')
    expect(seen).toHaveBeenCalledTimes(4)
    off()
  })
})
