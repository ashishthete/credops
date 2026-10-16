import { useEffect, useRef } from 'react'

// Combos that still fire while typing in a field; everything else yields to the input.
const ALLOWED_IN_INPUTS = new Set(['mod+k'])

interface Combo {
  key: string
  mod: boolean
  shift: boolean
  alt: boolean
  ctrl: boolean
}

export function isMac(): boolean {
  const platform = navigator.platform || navigator.userAgent
  return /mac|iphone|ipad/i.test(platform)
}

function parseCombo(combo: string): Combo {
  const parts = combo.toLowerCase().split('+')
  return {
    key: parts[parts.length - 1],
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
    ctrl: parts.includes('ctrl'),
  }
}

function keyMatches(key: string, e: KeyboardEvent): boolean {
  if (e.key?.toLowerCase() === key) return true
  // Fall back to the physical key so Alt/Shift-altered characters still match.
  if (/^[a-z]$/.test(key)) return e.code === `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return e.code === `Digit${key}`
  // Shift turns `]` into `}` on US layouts; match brackets by their physical key too.
  if (key === ']') return e.code === 'BracketRight'
  if (key === '[') return e.code === 'BracketLeft'
  return false
}

function matches(c: Combo, e: KeyboardEvent): boolean {
  const mac = isMac()
  const wantMeta = c.mod && mac
  const wantCtrl = c.ctrl || (c.mod && !mac)
  return (
    e.metaKey === wantMeta &&
    e.ctrlKey === wantCtrl &&
    e.shiftKey === c.shift &&
    e.altKey === c.alt &&
    keyMatches(c.key, e)
  )
}

/** xterm keeps a hidden textarea focused; app combos typed there are shortcuts, not typing. */
function isInTerminal(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('.xterm') !== null
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  )
}

/** Binds a global keyboard shortcut such as `mod+k` or `mod+1` (mod = ⌘ on macOS, Ctrl elsewhere). */
export function useShortcut(combo: string, handler: () => void): void {
  const handlerRef = useRef(handler)
  useEffect(() => {
    handlerRef.current = handler
  })

  useEffect(() => {
    const normalized = combo.toLowerCase()
    const parsed = parseCombo(normalized)
    const onKeyDown = (e: KeyboardEvent) => {
      // Skip IME composition and auto-repeat, so holding a toggle like ⌘K doesn't flicker.
      if (e.defaultPrevented || e.isComposing || e.repeat || !matches(parsed, e)) return
      const fromTerminal = parsed.mod && isInTerminal(e.target)
      if (!ALLOWED_IN_INPUTS.has(normalized) && !fromTerminal && isEditable(e.target)) return
      e.preventDefault()
      handlerRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [combo])
}

const KEY_LABELS: Record<string, string> = {
  enter: '↵',
  escape: 'Esc',
  backspace: '⌫',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  comma: ',',
}

/** Splits a combo into display keycaps, e.g. `mod+shift+p` → ['⌘', '⇧', 'P'] on macOS. */
export function formatShortcut(combo: string): string[] {
  const mac = isMac()
  return combo
    .toLowerCase()
    .split('+')
    .map((part) => {
      switch (part) {
        case 'mod':
          return mac ? '⌘' : 'Ctrl'
        case 'shift':
          return mac ? '⇧' : 'Shift'
        case 'alt':
          return mac ? '⌥' : 'Alt'
        case 'ctrl':
          return mac ? '⌃' : 'Ctrl'
        default:
          return KEY_LABELS[part] ?? part.toUpperCase()
      }
    })
}
