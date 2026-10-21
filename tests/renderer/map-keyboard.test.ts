import { describe, expect, it } from 'vitest'
import type { InventoryData } from '../../src/renderer/src/inventory/store'
import { buildGraph } from '../../src/renderer/src/map/graph'
import { focusModel, nextFocus, type FocusModel } from '../../src/renderer/src/map/keyboard'
import { environment, host, product, tunnelMeta } from './helpers'

function data(): InventoryData {
  return {
    products: [product({ id: 'p1', name: 'Platform' }), product({ id: 'p2', name: 'Shop' })],
    environments: [
      environment({ id: 'e1', name: 'Prod', productId: 'p1', hosts: [{ hostId: 'h1', role: 'bastion' }, { hostId: 'h2', role: 'app' }, { hostId: 'h3', role: 'db' }] }),
      environment({ id: 'e2', name: 'Stage', productId: 'p1', hosts: [{ hostId: 'h2', role: 'app' }] }),
      environment({ id: 'e3', name: 'Checkout', productId: 'p2', hosts: [{ hostId: 'h3', role: 'db' }] }),
    ],
    hosts: [host({ id: 'h1', label: 'web' }), host({ id: 'h2', label: 'api' }), host({ id: 'h3', label: 'pg' })],
    identities: [],
    vaults: [],
  }
}

const model = (tunnels = [] as ReturnType<typeof tunnelMeta>[]): FocusModel =>
  focusModel(buildGraph({ data: data(), tunnels, scope: { kind: 'all' } }))

/** Presses each key in turn from `start`, collecting where focus lands. */
function walk(m: FocusModel, start: string | null, keys: string[]): (string | null)[] {
  const out: (string | null)[] = []
  let at = start
  for (const k of keys) out.push((at = nextFocus(m, at, k)))
  return out
}

describe('map keyboard focus', () => {
  it('arrow keys walk the hierarchy', () => {
    expect(walk(model(), null, ['ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowLeft'])).toEqual([
      'p:p1',
      'e:e1',
      'e:e1/h:h1',
      'e:e1/h:h2',
      'e:e1',
      'p:p1',
    ])
    // Any arrow starts at the first node, and a stale id starts over too.
    expect(nextFocus(model(), null, 'ArrowLeft')).toBe('p:p1')
    expect(nextFocus(model(), 'e:gone', 'ArrowUp')).toBe('p:p1')
    // Other keys leave focus alone.
    expect(nextFocus(model(), 'e:e1', 'Enter')).toBe('e:e1')
    expect(nextFocus(model(), null, 'x')).toBeNull()
  })

  it('stops at sibling ends; Home and End jump', () => {
    const m = model()
    expect(walk(m, 'e:e1/h:h1', ['ArrowUp'])).toEqual(['e:e1/h:h1'])
    expect(walk(m, 'e:e1/h:h1', ['ArrowDown', 'ArrowDown', 'ArrowDown'])).toEqual(['e:e1/h:h2', 'e:e1/h:h3', 'e:e1/h:h3'])
    expect(nextFocus(m, 'e:e1/h:h2', 'End')).toBe('e:e1/h:h3')
    expect(nextFocus(m, 'e:e1/h:h3', 'Home')).toBe('e:e1/h:h1')
    // Environments are siblings under their product, products at the top level.
    expect(walk(m, 'e:e1', ['ArrowDown', 'ArrowDown'])).toEqual(['e:e2', 'e:e2'])
    expect(walk(m, 'p:p1', ['ArrowDown', 'ArrowDown', 'Home'])).toEqual(['p:p2', 'p:p2', 'p:p1'])
    // A leaf goes no further right; a product no further left.
    expect(nextFocus(m, 'e:e1/h:h2', 'ArrowRight')).toBe('e:e1/h:h2')
    expect(nextFocus(m, 'p:p2', 'ArrowLeft')).toBe('p:p2')
    expect(walk(m, 'p:p2', ['ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowLeft'])).toEqual(['e:e3', 'e:e3/h:h3', 'e:e3', 'p:p2'])
  })

  it('a host with tunnels goes right to this Mac', () => {
    const m = model([tunnelMeta({ id: 't1', hostId: 'h2', environmentId: 'e2' })])
    expect(m.children['e:e2/h:h2']).toEqual(['mac'])
    expect(nextFocus(m, 'e:e2/h:h2', 'ArrowRight')).toBe('mac')
    // The tunnel is drawn from the Stage placement only.
    expect(nextFocus(m, 'e:e1/h:h2', 'ArrowRight')).toBe('e:e1/h:h2')
    // This Mac sits at the top level, after the products.
    expect(m.parent.mac).toBeNull()
    expect(walk(m, 'p:p1', ['End', 'ArrowUp'])).toEqual(['mac', 'p:p2'])
  })
})
