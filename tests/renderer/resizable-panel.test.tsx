import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResizablePanel } from '../../src/renderer/src/ui/ResizablePanel'

const KEY = 'opsdeck.panel-width.test'

function setup() {
  render(
    <div className="flex">
      <ResizablePanel panel="test" defaultWidth={300} label="Things">
        <p>body</p>
      </ResizablePanel>
    </div>,
  )
  return screen.getByRole('separator')
}
const widthOf = () => (screen.getByRole('complementary', { name: 'Things' }).parentElement as HTMLElement).style.width

describe('ResizablePanel', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('exposes separator semantics', () => {
    const h = setup()
    expect(h).toHaveAttribute('aria-orientation', 'vertical')
    expect(h).toHaveAttribute('aria-valuenow', '300')
    expect(h).toHaveAttribute('aria-valuemin', '200')
    expect(h).toHaveAttribute('aria-valuemax', '560')
    expect(h).toHaveAttribute('tabindex', '0')
  })

  it('moves 16px per arrow key and clamps to 200-560', () => {
    const h = setup()
    fireEvent.keyDown(h, { key: 'ArrowRight' })
    expect(widthOf()).toBe('316px')
    fireEvent.keyDown(h, { key: 'ArrowLeft' })
    fireEvent.keyDown(h, { key: 'ArrowLeft' })
    expect(widthOf()).toBe('284px')
    for (let i = 0; i < 40; i++) fireEvent.keyDown(h, { key: 'ArrowLeft' })
    expect(widthOf()).toBe('200px')
    for (let i = 0; i < 60; i++) fireEvent.keyDown(h, { key: 'ArrowRight' })
    expect(widthOf()).toBe('560px')
  })

  it('resets on double-click', () => {
    const h = setup()
    fireEvent.keyDown(h, { key: 'ArrowRight' })
    fireEvent.doubleClick(h)
    expect(widthOf()).toBe('300px')
    expect(localStorage.getItem(KEY)).toBe('300')
  })

  it('persists and restores the width', () => {
    fireEvent.keyDown(setup(), { key: 'ArrowRight' })
    expect(localStorage.getItem(KEY)).toBe('316')
    document.body.innerHTML = ''
    setup()
    expect(widthOf()).toBe('316px')
  })

  it('follows a pointer drag and persists on release', () => {
    const h = setup()
    fireEvent.pointerDown(h, { button: 0, clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(h, { clientX: 380, pointerId: 1 })
    expect(widthOf()).toBe('380px')
    fireEvent.pointerMove(h, { clientX: 9000, pointerId: 1 })
    expect(widthOf()).toBe('560px')
    fireEvent.pointerUp(h, { clientX: 340, pointerId: 1 })
    expect(widthOf()).toBe('340px')
    expect(localStorage.getItem(KEY)).toBe('340')
  })

  it('reverts a cancelled drag without persisting', () => {
    const h = setup()
    fireEvent.pointerDown(h, { button: 0, clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(h, { clientX: 400, pointerId: 1 })
    expect(document.body.style.cursor).toBe('col-resize')
    fireEvent.pointerCancel(h, { clientX: 0, pointerId: 1 })
    expect(widthOf()).toBe('300px')
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(document.body.style.cursor).toBe('')
  })

  it('reverts when pointer capture is lost mid-drag', () => {
    const h = setup()
    fireEvent.pointerDown(h, { button: 0, clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(h, { clientX: 400, pointerId: 1 })
    fireEvent.lostPointerCapture(h, { pointerId: 1 })
    expect(widthOf()).toBe('300px')
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('works when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const h = setup()
    fireEvent.keyDown(h, { key: 'ArrowRight' })
    expect(widthOf()).toBe('316px')
  })
})
