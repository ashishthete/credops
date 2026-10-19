import './flow-stubs'
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inventoryStore } from '../../src/renderer/src/inventory/store'
import { resetTunnels } from '../../src/renderer/src/tunnels/store'
import { environment, host, mockBridge, renderShell } from './helpers'

// Records the props of every <ReactFlow> render; the real component still renders.
const flowProps = vi.hoisted(() => [] as Record<string, unknown>[])
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  const { createElement } = await import('react')
  return {
    ...actual,
    ReactFlow: (props: Parameters<typeof actual.ReactFlow>[0]) => {
      flowProps.push(props as Record<string, unknown>)
      return createElement(actual.ReactFlow, props)
    },
  }
})

const flush = () => act(async () => {})

async function renderWith(hostCount: number) {
  const hosts = Array.from({ length: hostCount }, (_, i) => host({ id: `h${i}`, label: `host-${i}` }))
  mockBridge({
    'env:list': [environment({ id: 'e1', name: 'Prod', hosts: hosts.map((h) => ({ hostId: h.id, role: 'app' as const })) })],
    'host:list': hosts,
  })
  renderShell('/map')
  await flush()
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  inventoryStore.set(null)
  resetTunnels()
  flowProps.length = 0
})

afterEach(async () => {
  cleanup()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  vi.useRealTimers()
  resetTunnels()
})

describe('map virtualization', () => {
  it('virtualizes past 120 nodes', async () => {
    await renderWith(130)
    expect(flowProps.at(-1)).toMatchObject({ onlyRenderVisibleElements: true })
  })

  it('renders everything below it', async () => {
    await renderWith(10)
    expect(flowProps.at(-1)).toMatchObject({ onlyRenderVisibleElements: false })
  })
})
