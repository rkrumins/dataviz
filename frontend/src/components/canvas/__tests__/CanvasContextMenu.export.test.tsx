/**
 * Right-click an entity → Export with children…, where the canvas offers it (a data source with
 * version control, export allowed): it hands the entity on, and the menu closes. Elsewhere it isn't
 * offered.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CanvasContextMenu } from '../CanvasContextMenu'

function renderMenu(onExportNode?: (id: string) => void) {
  const onClose = vi.fn()
  render(
    <CanvasContextMenu isOpen position={{ x: 10, y: 10 }} target={{ type: 'node', id: 'orders' }}
      onClose={onClose} onExportNode={onExportNode} />,
  )
  return onClose
}

describe('CanvasContextMenu — Export with children', () => {
  it('hands the entity right-clicked on to be exported with what is inside it', () => {
    const onExportNode = vi.fn()
    const onClose = renderMenu(onExportNode)
    fireEvent.click(screen.getByRole('button', { name: /Export with children…/ }))
    expect(onExportNode).toHaveBeenCalledWith('orders')
    expect(onClose).toHaveBeenCalled()
  })

  it('is not offered where the canvas cannot export', () => {
    renderMenu()
    expect(screen.queryByRole('button', { name: /Export with children/ })).not.toBeInTheDocument()
  })
})
