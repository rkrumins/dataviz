/**
 * Right-click an entity → Narrow to this…: one entry per reach, in a submenu,
 * with Back to the entity's menu. Offered only when the canvas gives entries.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CanvasContextMenu, type ContextMenuAction } from '../CanvasContextMenu'

function renderMenu(narrowActions: ContextMenuAction[]) {
  render(
    <CanvasContextMenu
      isOpen
      position={{ x: 10, y: 10 }}
      target={{ type: 'node', id: 'orders' }}
      onClose={vi.fn()}
      onEditNode={vi.fn()}
      narrowActions={narrowActions}
    />,
  )
}

describe('CanvasContextMenu — Narrow to this', () => {
  it('opens a submenu of reaches, and an entry does what it says', () => {
    const upstream = vi.fn()
    renderMenu([
      { id: 'narrow-one-level', label: 'One level in', icon: 'ListTree', onClick: vi.fn() },
      { id: 'narrow-upstream', label: 'Entire upstream', icon: 'ArrowUpLeft', disabled: false, onClick: upstream },
      { id: 'narrow-downstream', label: 'Entire downstream', icon: 'ArrowDownRight', disabled: true, onClick: vi.fn() },
    ])
    fireEvent.click(screen.getByText('Narrow to this…'))
    expect(screen.getByText('Narrow to this — how far?')).toBeInTheDocument()
    expect(screen.queryByText('View & Edit')).toBeNull()
    expect(screen.getByRole('menuitem', { name: /Entire downstream/ })).toBeDisabled()

    fireEvent.click(screen.getByRole('menuitem', { name: /Entire upstream/ }))
    expect(upstream).toHaveBeenCalledOnce()
  })

  it('Back returns to the entity’s menu', () => {
    renderMenu([{ id: 'narrow-one-level', label: 'One level in', icon: 'ListTree', onClick: vi.fn() }])
    fireEvent.click(screen.getByText('Narrow to this…'))
    fireEvent.click(screen.getByText('Back'))
    expect(screen.getByText('View & Edit')).toBeInTheDocument()
  })

  it('is not offered without entries', () => {
    renderMenu([])
    expect(screen.queryByText('Narrow to this…')).toBeNull()
  })

  it('a layer’s menu narrows to what is in the layer', () => {
    const onNarrow = vi.fn()
    render(
      <CanvasContextMenu
        isOpen
        position={{ x: 10, y: 10 }}
        target={{ type: 'layer', layerId: 'gold' }}
        onClose={vi.fn()}
        layerMenu={{
          name: 'Gold', color: '#ca8a04', index: 0, count: 2, folded: false, canEdit: false,
          onInsert: vi.fn(), onRename: vi.fn(), onRecolor: vi.fn(), onMove: vi.fn(), onDelete: vi.fn(), onNarrow,
        }}
      />,
    )
    fireEvent.click(screen.getByText('Narrow to this layer…'))
    expect(onNarrow).toHaveBeenCalledOnce()
  })
})
