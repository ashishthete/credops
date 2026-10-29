import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('window drag strips', () => {
  // Electron finds drag strips from CSS, not from what is drawn on top: a sheet or dialog over a page header
  // has to opt out, or its buttons (the logs drawer's close) drag the window instead of clicking.
  it('overlays opt out of the header drag strip', () => {
    const css = readFileSync('src/renderer/src/styles.css', 'utf8')
    const rule = /:is\(([^)]*)\),\s*\.app-no-drag\s*\{\s*-webkit-app-region: no-drag;/.exec(css)
    expect(rule?.[1]).toContain("[role='dialog']")
    expect(rule?.[1]).toContain("[role='menu']")
    for (const f of ['src/renderer/src/pages/ops/containers/LogsDrawer.tsx', 'src/renderer/src/ui/Dialog.tsx', 'src/renderer/src/ui/CommandPalette.tsx'])
      expect(readFileSync(f, 'utf8')).toMatch(/app-no-drag fixed inset-0/)
  })
})
