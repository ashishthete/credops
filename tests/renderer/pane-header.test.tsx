import { render, screen } from '@testing-library/react'
import { Pencil } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { PaneHeader, paneLabel } from '../../src/renderer/src/pages/products/ProductView'
import { Badge } from '../../src/renderer/src/ui/Badge'
import { Button } from '../../src/renderer/src/ui/Button'

describe('PaneHeader', () => {
  const title = 'Enterprise Platform Services'
  const view = () =>
    render(
      <PaneHeader
        lead={null}
        title={title}
        badges={<Badge>1 environment</Badge>}
        actions={<Button size="sm" variant="ghost" icon={<Pencil aria-hidden />} {...paneLabel('Edit')} />}
      />,
    )

  it('gives a truncated title its full name as a tooltip', () => {
    view()
    expect(screen.getByRole('heading', { name: title })).toHaveAttribute('title', title)
  })

  it('keeps a badge on one line', () => {
    view()
    expect(screen.getByText('1 environment')).toHaveClass('whitespace-nowrap', 'shrink-0')
  })

  it('collapses a secondary button to its icon on a narrow pane, keeping its name', () => {
    const { container } = view()
    const edit = screen.getByRole('button', { name: 'Edit' })
    expect(edit).toHaveAttribute('title', 'Edit')
    expect(edit.querySelector('span.hidden')).toHaveTextContent('Edit')
    expect(container.querySelector('header')).toHaveClass('@container/pane')
  })
})
