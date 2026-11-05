/**
 * ExplorerEmptyState when there are no views at all. Someone who can create a view is offered
 * to; someone who cannot is told how views reach them — by being shared — and where to see what
 * they can reach, instead of a create button, a setup pill and a guide to building.
 *
 * MemoryRouter is load-bearing: both states render router links.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExplorerEmptyState } from '../ExplorerEmptyState'
import { useWorkspacesStore } from '@/store/workspaces'
import type { WorkspaceResponse } from '@/services/workspaceService'

function renderEmpty(onCreateView?: () => void) {
  return render(
    <MemoryRouter>
      <ExplorerEmptyState type="no-views" onCreateView={onCreateView} />
    </MemoryRouter>,
  )
}

// A workspace whose data source has a semantic layer: what the creator's pill announces.
beforeEach(() => {
  useWorkspacesStore.setState({
    workspaces: [{
      id: 'ws_1', name: 'Finance', isDefault: true, isActive: true,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      dataSources: [{
        id: 'ds_1', workspaceId: 'ws_1', ontologyId: 'ont_1', accessLevel: 'read', isPrimary: true, isActive: true,
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        aggregationStatus: 'ready', aggregationEdgeCount: 0,
      }],
    } satisfies WorkspaceResponse],
    activeWorkspaceId: 'ws_1',
    activeDataSourceId: 'ds_1',
  })
})

describe('ExplorerEmptyState with no views yet', () => {
  it('offers someone who can create a view the way to make their first', () => {
    const onCreateView = vi.fn()
    renderEmpty(onCreateView)
    expect(screen.getByText('No views yet')).toBeInTheDocument()
    expect(screen.getByText(/is ready with semantic layer configured/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Create Your First View/ }))
    expect(onCreateView).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('link', { name: /See your access/ })).toBeNull()
  })

  it('tells someone who cannot that views reach them by being shared, and where to see their access', () => {
    renderEmpty()
    expect(screen.getByText('Nothing shared with you yet')).toBeInTheDocument()
    expect(screen.getByText('Views appear here once someone shares one with you or your workspace.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /See your access/ })).toHaveAttribute('href', '/my/access')

    expect(screen.queryByText('No views yet')).toBeNull()
    expect(screen.queryByText(/semantic layer configured/)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    // The only link is to their access — not the guide to creating views.
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })
})
