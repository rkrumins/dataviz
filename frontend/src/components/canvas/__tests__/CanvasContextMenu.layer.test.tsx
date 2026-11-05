/**
 * The layer menu — right-click a column header or a Layer Strip pill. In a draft
 * it inserts a layer on either side, renames, recolours, moves and deletes; a
 * move past either end isn't offered. Outside a draft it says layers change in
 * a draft and offers to start one.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CanvasContextMenu, type LayerMenuModel } from '../CanvasContextMenu'
import { LAYER_COLORS } from '@/components/views/ViewWizard/layerColors'

function model(over: Partial<LayerMenuModel> = {}): LayerMenuModel {
  return {
    name: 'Staging',
    color: LAYER_COLORS[1],
    index: 1,
    count: 3,
    folded: false,
    canEdit: true,
    onInsert: vi.fn(),
    onRename: vi.fn(),
    onRecolor: vi.fn(),
    onMove: vi.fn(),
    onToggleFold: vi.fn(),
    onDelete: vi.fn(),
    onStartEditing: vi.fn(),
    ...over,
  }
}

function open(layerMenu: LayerMenuModel) {
  const onClose = vi.fn()
  render(
    <CanvasContextMenu
      isOpen
      position={{ x: 10, y: 10 }}
      target={{ type: 'layer', layerId: 'l1' }}
      onClose={onClose}
      layerMenu={layerMenu}
    />,
  )
  return onClose
}

describe('CanvasContextMenu — layer target', () => {
  it('names the layer and inserts on either side', () => {
    const m = model()
    const onClose = open(m)
    expect(screen.getByText('Staging')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Insert layer to the left/ }))
    expect(m.onInsert).toHaveBeenCalledWith('left')
    expect(onClose).toHaveBeenCalled()
  })

  it('inserts to the right, renames, moves and deletes', () => {
    const m = model()
    open(m)
    fireEvent.click(screen.getByRole('button', { name: /Insert layer to the right/ }))
    expect(m.onInsert).toHaveBeenCalledWith('right')
    fireEvent.click(screen.getByRole('button', { name: /^Rename/ }))
    expect(m.onRename).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Move right/ }))
    expect(m.onMove).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByRole('button', { name: /Delete layer/ }))
    expect(m.onDelete).toHaveBeenCalled()
  })

  it('does not offer a move past either end', () => {
    open(model({ index: 0, count: 2 }))
    expect(screen.getByRole('button', { name: /Move left/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Move right/ })).not.toBeDisabled()
  })

  it('recolours in one click, with the current colour ticked', () => {
    const m = model()
    open(m)
    const swatches = screen.getAllByRole('radio')
    expect(swatches).toHaveLength(LAYER_COLORS.length)
    expect(swatches[1]).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(swatches[4])
    expect(m.onRecolor).toHaveBeenCalledWith(LAYER_COLORS[4])
  })

  it('outside a draft: explains, offers fold and Start editing, and nothing that edits', () => {
    const m = model({ canEdit: false })
    open(m)
    expect(screen.getByText(/Layers change in a draft/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Insert layer/ })).toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Fold layer/ }))
    expect(m.onToggleFold).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Start editing to change layers/ }))
    expect(m.onStartEditing).toHaveBeenCalled()
  })

  it('opens the layer\'s settings in a draft — and its details outside one', () => {
    const onOpenSettings = vi.fn()
    open(model({ onOpenSettings }))
    fireEvent.click(screen.getByRole('button', { name: /Layer settings…/ }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    cleanup()
    open(model({ onOpenSettings, canEdit: false }))
    expect(screen.getByRole('button', { name: /Layer details…/ })).toBeInTheDocument()
  })

  it('carries the header\'s own actions where the header keeps to the essentials', () => {
    const m = model({ onAddEntity: vi.fn(), onNewGroup: vi.fn(), onBuild: vi.fn() })
    open(m)
    fireEvent.click(screen.getByRole('button', { name: /Add entity/ }))
    expect(m.onAddEntity).toHaveBeenCalled()
    cleanup()
    open(m)
    fireEvent.click(screen.getByRole('button', { name: /New group/ }))
    expect(m.onNewGroup).toHaveBeenCalled()
    cleanup()
    open(m)
    fireEvent.click(screen.getByRole('button', { name: /Build a lot at once/ }))
    expect(m.onBuild).toHaveBeenCalled()
  })

  it('opened from the header\'s ⋯ button, takes the keyboard in, and gives it back', () => {
    const trigger = document.createElement('button')
    trigger.setAttribute('data-canvas-menu-trigger', '')
    document.body.appendChild(trigger)
    trigger.focus()
    const props = { position: { x: 10, y: 10 }, target: { type: 'layer', layerId: 'l1' } as const, onClose: vi.fn(), layerMenu: model({ onOpenSettings: vi.fn() }) }
    const { rerender } = render(<CanvasContextMenu isOpen {...props} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Layer settings…/ }))
    rerender(<CanvasContextMenu isOpen={false} {...props} />)
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('opened by a right-click, leaves the focus where it was', () => {
    const before = document.activeElement
    open(model({ onOpenSettings: vi.fn() }))
    expect(document.activeElement).toBe(before)
  })
})
