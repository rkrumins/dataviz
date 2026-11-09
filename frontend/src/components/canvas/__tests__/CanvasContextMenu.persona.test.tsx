/**
 * The entity menu in each view: the Business view reads and walks an entity
 * (details, trace, focus); copying its identifier and narrowing the canvas to
 * it are the Technical view's, which keeps every item it has always had.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { usePersonaStore } from '@/store/persona'

import { CanvasContextMenu } from '../CanvasContextMenu'

function renderMenu() {
  render(
    <CanvasContextMenu
      isOpen
      position={{ x: 10, y: 10 }}
      target={{ type: 'node', id: 'orders' }}
      onClose={vi.fn()}
      onEditNode={vi.fn()}
      onTraceNode={vi.fn()}
      onFocusConnections={vi.fn()}
      onCopyUrn={vi.fn()}
      narrowActions={[{ id: 'narrow-one-level', label: 'One level in', icon: 'ListTree', onClick: vi.fn() }]}
    />,
  )
}

describe('CanvasContextMenu — an entity, in each view', () => {
  it('Business: reads and walks, with no identifier to copy and no narrowing', () => {
    usePersonaStore.setState({ mode: 'business' })
    renderMenu()
    expect(screen.getByText('View & Edit')).toBeInTheDocument()
    expect(screen.getByText('Trace Lineage')).toBeInTheDocument()
    expect(screen.getByText('Focus Connections')).toBeInTheDocument()
    expect(screen.queryByText('Copy URN')).toBeNull()
    expect(screen.queryByText('Narrow to this…')).toBeNull()
  })

  it('Technical: every item, as before', () => {
    renderMenu()
    expect(screen.getByText('View & Edit')).toBeInTheDocument()
    expect(screen.getByText('Copy URN')).toBeInTheDocument()
    expect(screen.getByText('Narrow to this…')).toBeInTheDocument()
  })
})
