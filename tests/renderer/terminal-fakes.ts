import { vi, type Mock } from 'vitest'

/** Shared state for the faked xterm modules; reset with resetFakeXterm(). */
export const fake = {
  terms: [] as FakeTerminal[],
  fitSize: { cols: 100, rows: 30 },
}

export function resetFakeXterm() {
  fake.terms = []
  fake.fitSize = { cols: 100, rows: 30 }
}

export class FakeTerminal {
  cols = 80
  rows = 24
  element: HTMLElement | undefined
  write: Mock<(...args: any[]) => any> = vi.fn()
  dispose: Mock<(...args: any[]) => any> = vi.fn()
  focus: Mock<(...args: any[]) => any> = vi.fn()
  getSelection: Mock<(...args: any[]) => any> = vi.fn(() => '')
  dataListeners: ((d: string) => void)[] = []
  selectionListeners: (() => void)[] = []
  keyHandler: (e: KeyboardEvent) => boolean = () => true
  constructor(public options: Record<string, unknown>) {
    fake.terms.push(this)
  }
  open(parent: HTMLElement) {
    this.element = document.createElement('div')
    this.element.className = 'terminal xterm'
    parent.appendChild(this.element)
  }
  loadAddon(addon: { activate?: (t: FakeTerminal) => void }) {
    addon.activate?.(this)
  }
  onData(l: (d: string) => void) {
    this.dataListeners.push(l)
    return { dispose: () => (this.dataListeners = this.dataListeners.filter((x) => x !== l)) }
  }
  onSelectionChange(l: () => void) {
    this.selectionListeners.push(l)
    return { dispose: () => (this.selectionListeners = this.selectionListeners.filter((x) => x !== l)) }
  }
  attachCustomKeyEventHandler(h: (e: KeyboardEvent) => boolean) {
    this.keyHandler = h
  }
  type(data: string) {
    this.dataListeners.forEach((l) => l(data))
  }
}

export class FakeFit {
  term!: FakeTerminal
  activate(t: FakeTerminal) {
    this.term = t
  }
  fit: Mock<(...args: any[]) => any> = vi.fn(() => {
    this.term.cols = fake.fitSize.cols
    this.term.rows = fake.fitSize.rows
  })
}

export class FakeSearch {
  findNext: Mock<(...args: any[]) => any> = vi.fn()
  findPrevious: Mock<(...args: any[]) => any> = vi.fn()
  clearDecorations: Mock<(...args: any[]) => any> = vi.fn()
}

export class FakeWebLinks {
  constructor(public handler: (e: MouseEvent, url: string) => void) {}
}
