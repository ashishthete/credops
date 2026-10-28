import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { resetKept } from '../../src/renderer/src/ui/kept'

// jsdom has no matchMedia; report "no preference" for every query.
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
}

// jsdom doesn't scroll and logs "Not implemented" for every scrollTo; make it a no-op.
window.scrollTo = () => {}

// xterm probes a 2D canvas when it loads (the shell imports it); jsdom has none and logs "Not implemented".
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext

afterEach(() => {
  cleanup()
  // Pages keep filters and drafts across navigation; each test starts without them.
  resetKept()
})

// Tests run as macOS, so `mod` is the Meta key.
Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true })
