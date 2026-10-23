import { readFileSync, renameSync, writeFileSync } from 'node:fs'

export const MIN_WIDTH = 960
export const MIN_HEIGHT = 640
export const WINDOW_STATE_FILE = 'window-state.json'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState {
  bounds: Rect
  maximized: boolean
  fullScreen: boolean
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function parseWindowState(raw: unknown): WindowState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { bounds: b, maximized, fullScreen } = raw as Record<string, unknown>
  if (typeof b !== 'object' || b === null) return null
  const { x, y, width, height } = b as Record<string, unknown>
  if (!num(x) || !num(y) || !num(width) || !num(height)) return null
  return { bounds: { x, y, width, height }, maximized: maximized === true, fullScreen: fullScreen === true }
}

/** How much of `a` lies inside `b`, in square points. */
function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Where the window opens. The saved bounds, when a display still shows enough of them, sized to fit
 * that display and pulled fully onto it; otherwise the whole primary work area. Maximized and full
 * screen carry over either way.
 */
export function initialWindowState(saved: WindowState | null, workAreas: Rect[], primary: Rect): WindowState {
  if (!saved) return { bounds: { ...primary }, maximized: false, fullScreen: false }
  const { maximized, fullScreen } = saved
  const home = workAreas.find((a) => overlap(saved.bounds, a) >= 100 * 50)
  if (!home) return { bounds: { ...primary }, maximized, fullScreen }
  const width = Math.min(Math.max(saved.bounds.width, MIN_WIDTH), home.width)
  const height = Math.min(Math.max(saved.bounds.height, MIN_HEIGHT), home.height)
  const x = Math.min(Math.max(saved.bounds.x, home.x), home.x + home.width - width)
  const y = Math.min(Math.max(saved.bounds.y, home.y), home.y + home.height - height)
  return { bounds: { x, y, width, height }, maximized, fullScreen }
}

/** A missing or unreadable file is simply no saved state. */
export function loadWindowState(file: string): WindowState | null {
  try {
    return parseWindowState(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

export function saveWindowState(file: string, state: WindowState): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(state))
  renameSync(tmp, file)
}
