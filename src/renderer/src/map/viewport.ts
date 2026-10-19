import { useCallback, useSyncExternalStore } from 'react'
import { createStore } from '../ui/store'
import type { Pins } from './layout'

export interface Viewport {
  x: number
  y: number
  zoom: number
}

// Per-scope viewports, `{ [scopeKey]: { x, y, zoom } }`, oldest write first.
export const VIEWPORT_KEY = 'opsdeck.map.viewport'
export const MAX_VIEWPORTS = 32
/** The canvas's zoom range; a stored zoom outside it is pulled back in. */
export const MIN_ZOOM = 0.2
export const MAX_ZOOM = 2

const isViewport = (v: unknown): v is Viewport =>
  typeof v === 'object' &&
  v !== null &&
  ['x', 'y', 'zoom'].every((k) => Number.isFinite((v as Record<string, unknown>)[k])) &&
  (v as Viewport).zoom > 0

const clean = (v: Viewport): Viewport => ({ x: v.x, y: v.y, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom)) })

/** Every valid entry, in write order; anything unreadable reads as nothing stored. */
function readAll(): [string, Viewport][] {
  try {
    const raw = localStorage.getItem(VIEWPORT_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
    return Object.entries(parsed).flatMap(([k, v]) => (isViewport(v) ? [[k, clean(v)] as [string, Viewport]] : []))
  } catch {
    return []
  }
}

export function loadViewport(scopeKey: string): Viewport | null {
  return readAll().find(([k]) => k === scopeKey)?.[1] ?? null
}

/** Writes `scopeKey` as the newest entry, dropping the oldest past MAX_VIEWPORTS. */
export function saveViewport(scopeKey: string, vp: Viewport): void {
  if (!isViewport(vp)) return
  // Scope keys are never integer-like ('all', 'p:…', 'e:…'), so object key order is write order.
  const entries = [...readAll().filter(([k]) => k !== scopeKey), [scopeKey, clean(vp)] as [string, Viewport]]
  try {
    localStorage.setItem(VIEWPORT_KEY, JSON.stringify(Object.fromEntries(entries.slice(-MAX_VIEWPORTS))))
  } catch {
    // Storage unavailable; the map fits the view next time instead.
  }
}

/**
 * Dragged positions per scope, kept in memory: they survive leaving the page, not a restart. A store,
 * so the palette's Reset map layout re-renders the map as the toolbar's button does.
 */
export const pinsStore = createStore<Record<string, Pins>>({})

const NO_PINS: Pins = {}

export function setPin(scopeKey: string, id: string, pos: { x: number; y: number }): void {
  const all = pinsStore.get()
  pinsStore.set({ ...all, [scopeKey]: { ...all[scopeKey], [id]: { x: pos.x, y: pos.y } } })
}

export function clearPins(scopeKey: string): void {
  const all = pinsStore.get()
  if (!(scopeKey in all)) return
  const { [scopeKey]: _, ...rest } = all
  pinsStore.set(rest)
}

/** The pins for one scope; the same object until that scope's pins change. */
export function usePins(scopeKey: string): Pins {
  const snapshot = useCallback(() => pinsStore.get()[scopeKey] ?? NO_PINS, [scopeKey])
  return useSyncExternalStore(pinsStore.subscribe, snapshot)
}
