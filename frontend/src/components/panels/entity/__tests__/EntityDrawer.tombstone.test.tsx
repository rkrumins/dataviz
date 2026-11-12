/**
 * EntityDrawer on a tombstone — a deletion drawn where it was: its details (who deleted it, when,
 * where it lived) take the place of a live entity's view and of the trace actions, which have no
 * lineage to follow; Restore sits with them where the canvas can be edited.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { buildChangeSet } from '@/features/versioning/model/changeModel'

const h = vi.hoisted(() => ({ restore: vi.fn(), deletionArgs: [] as unknown[] }))
vi.mock('@/features/versioning/hooks/useEntityEditing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/versioning/hooks/useEntityEditing')>()),
  useEntityEditing: () => ({ offered: false, blocked: null }),
}))
vi.mock('@/features/versioning/hooks/useVersioning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/versioning/hooks/useVersioning')>()),
  useResolveGraph: () => ({ data: { graphId: 'g', mainBranchId: 'main' }, isError: false }),
  useEntitySummary: () => ({ data: undefined, isLoading: false }),
  useProjectionWatermark: () => ({ data: undefined }),
  useEntityDeletion: (...args: unknown[]) => {
    h.deletionArgs = args
    return {
      isLoading: false, isError: false,
      data: {
        entityId: 'e-orders', kind: 'node', urn: 'urn:orders', ancestors: [{ urn: 'urn:sales', displayName: 'Sales' }],
        lastValue: { displayName: 'orders' }, userNames: { 'u-ana': 'Ana' },
        deleted: { seq: 9, commitId: 'c9', message: null, at: '2026-11-08T10:00:00Z', deletedBy: 'u-ana', inDraft: true },
      },
    }
  },
}))
vi.mock('@/components/panels/LineageNeighbors', () => ({ LineageNeighbors: () => null }))
vi.mock('@/components/canvas/context-view/useReparentNode', () => ({ useReparentNode: () => ({ reparent: vi.fn() }) }))
vi.mock('@/features/versioning/canvas/useRestoreGhost', () => ({ useRestoreGhost: () => h.restore, useRestoreDeletion: () => vi.fn() }))

import { EntityDrawer } from '../EntityDrawer'

const GHOST = {
  id: 'urn:orders', type: 'generic', position: { x: 0, y: 0 },
  data: { label: 'orders', type: 'dataset', urn: 'urn:orders', isGhost: true },
} as unknown as LineageNode

beforeEach(() => {
  h.restore.mockReset()
  useSchemaStore.setState({
    schema: { entityTypes: [], relationshipTypes: [], containmentEdgeTypes: [], views: [{ id: 'v', workspaceId: 'ws', dataSourceId: 'ds', entityOverrides: {} }] },
    activeViewId: 'v',
  } as never)
  useBranchStore.setState({ activeChangeSet: buildChangeSet([{
    entityId: 'e-orders', urn: 'urn:orders', kind: 'node', status: 'removed', label: 'orders',
    origin: { source: 'branch', branchId: 'd1' }, before: { displayName: 'orders' },
  }]) } as never)
  useCanvasStore.setState({ nodes: [GHOST], drawerNodeId: GHOST.id, drawerEdge: null, drawerDirty: false, pendingDrawerMove: null })
})

describe('EntityDrawer — a tombstone', () => {
  it('shows how it came to be deleted, by its own id and in its own draft, in place of the trace actions', () => {
    render(<EntityDrawer canEdit onTraceUp={vi.fn()} onTraceDown={vi.fn()} onFullTrace={vi.fn()} />)
    expect(screen.getByText('Deleted in this draft')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'How it was deleted' })).toHaveTextContent('by Ana')
    expect(h.deletionArgs.slice(0, 4)).toEqual(['ws', 'g', 'e-orders', { branchId: 'd1', atSeq: null, kind: 'node' }])
    expect(screen.queryByRole('button', { name: /^Root Cause/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(h.restore).toHaveBeenCalledWith('urn:orders')
  })

  it('offers no Restore where the canvas can’t be edited', () => {
    render(<EntityDrawer canEdit={false} />)
    expect(screen.getByText('Deleted in this draft')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull()
  })
})
