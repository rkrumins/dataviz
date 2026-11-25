/**
 * useRestoreGhost — what the open draft deleted and saved (a ghost on the canvas) comes back through
 * the draft's own restore of its changes, as discarding the deletion from Review does: asked for by
 * its entity id (a node's urn need not be it), with what its deletion took with it — an entity's
 * links and relationships, as they were (the server's closure) — and the canvas reads the draft again.
 */
import { createElement, type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ restore: vi.fn(), notify: vi.fn() }))
vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()),
  restoreDraftChanges: h.restore,
}))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: h.notify }) }))

import { useRestoreGhost } from '../useRestoreGhost'
import { useBranchStore } from '@/store/branchStore'
import { buildChangeSet, type GraphChange } from '../../model/changeModel'

const removed = (entityId: string, kind: 'node' | 'edge', label: string, extra: Partial<GraphChange> = {}): GraphChange => ({
  entityId, kind, status: 'removed', label, before: {}, origin: { source: 'branch', branchId: 'br' }, ...extra,
})

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: new QueryClient() }, children)

beforeEach(() => {
  h.restore.mockReset()
  h.notify.mockReset()
  useBranchStore.setState({
    workspaceId: 'ws', graphId: 'g', mainBranchId: 'main', currentBranchId: 'br', draftEpoch: 0,
    activeChangeSet: buildChangeSet([
      // An imported entity: its id is not the urn the canvas names it by.
      removed('ent_orders', 'node', 'Orders', { urn: 'urn:orders' }),
      removed('rel_1', 'edge', 'Orders → Revenue'),
    ]),
  } as never)
})

describe('useRestoreGhost', () => {
  it('brings an entity back by its entity id, with what its deletion took — and the canvas reads the draft again', async () => {
    h.restore.mockResolvedValue({ restored: 3, chosen: 1, implied: [], impliedCount: 2, dryRun: false, commitId: 'c9' })
    const { result } = renderHook(() => useRestoreGhost(), { wrapper })
    await act(async () => { await result.current('urn:orders') })
    expect(h.restore).toHaveBeenCalledWith('ws', 'g', 'br', { entityIds: ['ent_orders'] })
    expect(useBranchStore.getState().draftEpoch).toBe(1)
    expect(h.notify).toHaveBeenCalledWith('success', 'Restored Orders, with 2 more changes that went with it.')
  })

  it('brings a relationship back the same way', async () => {
    h.restore.mockResolvedValue({ restored: 1, chosen: 1, implied: [], impliedCount: 0, dryRun: false, commitId: 'c9' })
    const { result } = renderHook(() => useRestoreGhost(), { wrapper })
    await act(async () => { await result.current('rel_1') })
    expect(h.restore).toHaveBeenCalledWith('ws', 'g', 'br', { entityIds: ['rel_1'] })
    expect(h.notify).toHaveBeenCalledWith('success', 'Restored Orders → Revenue.')
  })

  it('says why when it can’t, and leaves the canvas as it is', async () => {
    h.restore.mockRejectedValue(new Error('The draft moved on'))
    const { result } = renderHook(() => useRestoreGhost(), { wrapper })
    await act(async () => { await result.current('rel_1') })
    expect(h.notify).toHaveBeenCalledWith('error', 'The draft moved on')
    expect(useBranchStore.getState().draftEpoch).toBe(0)
  })

  it('does nothing outside a draft', async () => {
    useBranchStore.setState({ currentBranchId: 'main' } as never)
    const { result } = renderHook(() => useRestoreGhost(), { wrapper })
    await act(async () => { await result.current('rel_1') })
    expect(h.restore).not.toHaveBeenCalled()
  })
})
