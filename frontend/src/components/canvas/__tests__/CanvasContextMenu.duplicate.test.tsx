/**
 * Right-click an entity → one Duplicate. Where the canvas offers the dialog it is
 * the item (it opens on the quick copy's choices); elsewhere the quick copy is.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CanvasContextMenu } from '../CanvasContextMenu'

function renderMenu(props: { onDuplicateNode?: (id: string) => void; onDuplicateWithOptions?: (id: string) => void }) {
  const onClose = vi.fn()
  render(
    <CanvasContextMenu
      isOpen
      position={{ x: 10, y: 10 }}
      target={{ type: 'node', id: 'orders' }}
      onClose={onClose}
      {...props}
    />,
  )
  return onClose
}

const labels = () => screen.getAllByRole('button').map((item) => item.textContent ?? '')

describe('CanvasContextMenu — Duplicate', () => {
  it('offers the dialog as the one Duplicate where the canvas has it', () => {
    const onDuplicateNode = vi.fn()
    const onDuplicateWithOptions = vi.fn()
    const onClose = renderMenu({ onDuplicateNode, onDuplicateWithOptions })
    const duplicates = labels().filter((label) => label.startsWith('Duplicate'))
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0]).toContain('Duplicate…')
    fireEvent.click(screen.getByRole('button', { name: /Duplicate…/ }))
    expect(onDuplicateWithOptions).toHaveBeenCalledWith('orders')
    expect(onDuplicateNode).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps the quick copy where there is no dialog', () => {
    const onDuplicateNode = vi.fn()
    renderMenu({ onDuplicateNode })
    const duplicates = labels().filter((label) => label.startsWith('Duplicate'))
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0]).not.toContain('…')
    fireEvent.click(screen.getByRole('button', { name: /^Duplicate/ }))
    expect(onDuplicateNode).toHaveBeenCalledWith('orders')
  })
})
