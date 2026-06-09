/**
 * ContextViewHeader — verifies the Explore↔Edit mode partition and the
 * scope-aware search escalation contract.
 *
 *  · Explore (default) exposes NO mutation controls — only the "Edit" entry.
 *  · Edit reveals Add Entity / Save Blueprint / Done.
 *  · The in-field "Entire graph" scope hands off to Advanced Search, seeded
 *    with the typed query (the contract ContextViewCanvas relies on).
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

import { ContextViewHeader, type ContextViewHeaderProps } from '../ContextViewHeader'

function baseProps(overrides: Partial<ContextViewHeaderProps> = {}): ContextViewHeaderProps {
  return {
    isEditing: false,
    onEnterEdit: vi.fn(),
    onExitEdit: vi.fn(),
    searchQuery: '',
    onSearchChange: vi.fn(),
    searchResults: [],
    onSearchResultClick: vi.fn(),
    showLineageFlow: false,
    onToggleLineageFlow: vi.fn(),
    showEdgeDirection: false,
    onToggleEdgeDirection: vi.fn(),
    lineageRenderMode: 'auto',
    onSetLineageRenderMode: vi.fn(),
    traceActive: false,
    canTrace: false,
    onStartTrace: vi.fn(),
    onExitTrace: vi.fn(),
    lineageReady: true,
    traceUpstreamDepth: 3,
    traceDownstreamDepth: 3,
    onSetTraceDepth: vi.fn(),
    onAddEntity: vi.fn(),
    onOpenAdvancedSearch: vi.fn(),
    activeWorkspaceId: 'ws1',
    activeContextModelName: null,
    syncStatus: 'idle',
    onSave: vi.fn(),
    canvasZoom: 1,
    onSetCanvasZoom: vi.fn(),
    canvasDensity: 'spacious',
    onSetCanvasDensity: vi.fn(),
    showCanvasTypeBadge: true,
    onToggleCanvasTypeBadge: vi.fn(),
    subtleCanvasTreeLines: false,
    onToggleSubtleCanvasTreeLines: vi.fn(),
    onResetCanvasDisplaySettings: vi.fn(),
    ...overrides,
  }
}

describe('ContextViewHeader', () => {
  it('Explore mode hides mutation controls and offers an Edit entry', () => {
    render(<ContextViewHeader {...baseProps({ isEditing: false })} />)
    expect(screen.getByRole('button', { name: /^Edit$/ })).toBeInTheDocument()
    expect(screen.queryByText('Add Entity')).not.toBeInTheDocument()
    expect(screen.queryByText('Save Blueprint')).not.toBeInTheDocument()
    expect(screen.queryByText('Done')).not.toBeInTheDocument()
  })

  it('Edit mode reveals authoring controls', () => {
    render(<ContextViewHeader {...baseProps({ isEditing: true })} />)
    expect(screen.getByText('Add Entity')).toBeInTheDocument()
    expect(screen.getByText('Save Blueprint')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit$/ })).not.toBeInTheDocument()
  })

  it('entering Edit calls onEnterEdit', () => {
    const onEnterEdit = vi.fn()
    render(<ContextViewHeader {...baseProps({ onEnterEdit })} />)
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }))
    expect(onEnterEdit).toHaveBeenCalledTimes(1)
  })

  it('the "Entire graph" scope escalates to Advanced Search seeded with the query', () => {
    const onOpenAdvancedSearch = vi.fn()
    render(<ContextViewHeader {...baseProps({ searchQuery: 'orders', onOpenAdvancedSearch })} />)
    fireEvent.click(screen.getByTitle(/across the entire graph/i))
    expect(onOpenAdvancedSearch).toHaveBeenCalledWith('orders')
  })
})
