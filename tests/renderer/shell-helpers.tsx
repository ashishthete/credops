import { render, type RenderResult } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { AppShell } from '../../src/renderer/src/shell/AppShell'

// Kept apart from helpers.tsx so suites that only want fixtures don't import the whole shell.

/** The whole shell at `path`; install the bridge (mockBridge) first. */
export function renderShell(path = '/'): RenderResult {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell />
    </MemoryRouter>,
  )
}
