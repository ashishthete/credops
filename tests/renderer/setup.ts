import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

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

afterEach(() => cleanup())

// Tests run as macOS, so `mod` is the Meta key.
Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true })
