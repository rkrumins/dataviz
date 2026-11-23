/**
 * Right-click an entity → Ask about this, after Focus Connections in the reading group: it hands
 * the entity on (the questions drawer opens about it) and the menu closes. Where questions are off,
 * or the canvas is no saved view, it isn't offered — and it never shows on an edge or the canvas.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CanvasContextMenu, type ContextMenuTarget } from '../CanvasContextMenu'

function renderMenu(onAskAboutNode?: (id: string) => void, target: ContextMenuTarget = { type: 'node', id: 'orders' }) {
  const onClose = vi.fn()
  render(
    <CanvasContextMenu isOpen position={{ x: 10, y: 10 }} target={target} onClose={onClose}
      onTraceNode={() => {}} onFocusConnections={() => {}} onAskAboutNode={onAskAboutNode} />,
  )
  return onClose
}

describe('CanvasContextMenu — Ask about this', () => {
  it('asks about the entity right-clicked, and closes', () => {
    const ask = vi.fn()
    const onClose = renderMenu(ask)
    fireEvent.click(screen.getByRole('button', { name: /Ask about this/ }))
    expect(ask).toHaveBeenCalledWith('orders')
    expect(onClose).toHaveBeenCalled()
  })

  it('sits right after Focus Connections', () => {
    renderMenu(vi.fn())
    const labels = screen.getAllByRole('button').map((b) => b.textContent ?? '')
    const focus = labels.findIndex((l) => l.includes('Focus Connections'))
    expect(focus).toBeGreaterThanOrEqual(0)
    expect(labels[focus + 1]).toContain('Ask about this')
  })

  it('is not offered where questions are off', () => {
    renderMenu(undefined)
    expect(screen.queryByRole('button', { name: /Ask about this/ })).not.toBeInTheDocument()
  })

  it('is not offered on a relationship or the empty canvas', () => {
    renderMenu(vi.fn(), { type: 'edge', id: 'e1', source: 'a', target: 'b' })
    expect(screen.queryByRole('button', { name: /Ask about this/ })).not.toBeInTheDocument()
  })
})
