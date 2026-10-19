// What React Flow reads from the DOM and jsdom lacks. Imported first by the map tests only, as a side
// effect; the global setup leaves other suites on jsdom's defaults. Safe to import more than once.

const FLAG = Symbol.for('opsdeck.flowStubs')
const FLOW_W = 1000
const FLOW_H = 800

/** The flow wrapper and anything sized in % get the stub viewport; px sizes are read back; else 1. */
function size(el: HTMLElement, axis: 'width' | 'height'): number {
  const fallback = axis === 'width' ? FLOW_W : FLOW_H
  if (el.classList.contains('react-flow')) return fallback
  const value = el.style[axis]
  if (value.endsWith('%')) return fallback
  return parseFloat(value || '1') || 1
}

const g = globalThis as unknown as Record<symbol, boolean>
if (!g[FLAG]) {
  g[FLAG] = true

  if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(el: Element) {
        const target = el as HTMLElement
        const contentRect = { width: size(target, 'width'), height: size(target, 'height') }
        this.callback([{ target, contentRect } as unknown as ResizeObserverEntry], this)
      }
      unobserve() {}
      disconnect() {}
    }
  }

  if (typeof window.DOMMatrixReadOnly === 'undefined') {
    // updateNodeInternals reads the zoom (m22) from the viewport's `translate(x, y) scale(z)`.
    class Matrix {
      a = 1
      b = 0
      c = 0
      d = 1
      e = 0
      f = 0
      constructor(transform?: string) {
        const matrix = transform?.match(/matrix\(([^)]+)\)/)
        const scale = transform?.match(/scale\(\s*([-\d.e]+)/)
        if (matrix) {
          const [a, b, c, d, e, f] = matrix[1].split(',').map((n) => parseFloat(n))
          Object.assign(this, { a, b, c, d, e, f })
        } else if (scale) {
          this.a = this.d = parseFloat(scale[1])
        }
      }
      get m11() {
        return this.a
      }
      get m22() {
        return this.d
      }
    }
    window.DOMMatrixReadOnly = Matrix as unknown as typeof DOMMatrixReadOnly
  }

  // jsdom defines these as 0, so they are replaced outright: measured nodes get their explicit size.
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return size(this, 'width')
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return size(this, 'height')
    },
  })

  if (!('getBBox' in SVGElement.prototype)) {
    Object.defineProperty(SVGElement.prototype, 'getBBox', {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    })
  }
}

export {}
