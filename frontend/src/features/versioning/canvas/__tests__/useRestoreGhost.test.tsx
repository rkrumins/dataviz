/**
 * useRestoreGhost on a draft too large for its whole diff: its change list has no payloads, so a
 * Restore first asks what the subtree and its links were (one request for up to 500), then stages
 * them as on any draft — and past its caps it says so instead of restoring part of it.
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getChangeEntriesBatch = vi.hoisted(() => vi.fn())
const notify = vi.hoisted(() => vi.fn())
vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()),
  getChangeEntriesBatch,
}))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))

import { queryClient } from '@/lib/queryClient'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { buildChangeSet, type GraphChange } from '../../model/changeModel'
import { useRestoreGhost } from '../useRestoreGhost'

const origin = { source: 'branch', branchId: 'draft-1' } as const
const bare = (urn: string): GraphChange => ({ entityId: urn, urn, kind: 'node', status: 'removed', label: urn, origin })
const link = (id: string, s: string, t: string, edgeType: string): GraphChange => ({
  entityId: id, kind: 'edge', status: 'removed', label: edgeType, origin, before: { edgeType, sourceEntityId: s, targetEntityId: t },
})

beforeEach(() => {
  queryClient.clear()
  getChangeEntriesBatch.mockReset()
  notify.mockReset()
  useStagedChangesStore.setState({ changes: [] })
  useSchemaStore.setState({ schema: { containmentEdgeTypes: ['CONTAINS'] } } as never)
  useCanvasStore.getState().setNodesAndEdges([{ id: 'urn:db', type: 'generic', position: { x: 0, y: 0 }, data: {} } as never], [])
  useBranchStore.setState({ workspaceId: 'ws', graphId: 'g', activeChangeSet: buildChangeSet([
    bare('urn:t1'), link('k1', 'urn:db', 'urn:t1', 'CONTAINS'), link('f1', 'urn:t1', 'urn:db', 'FLOWS_TO'),
  ]) } as never)
})

describe('useRestoreGhost — a draft without payloads', () => {
  it('asks what the subtree and its links were, then stages them with their ids', async () => {
    getChangeEntriesBatch.mockResolvedValue({ entries: [
      { entityId: 'urn:t1', kind: 'node', status: 'removed', after: null, before: { displayName: 'T1', entityType: 'Table' } },
      { entityId: 'f1', kind: 'edge', status: 'removed', after: null,
        before: { edgeType: 'FLOWS_TO', sourceEntityId: 'urn:t1', targetEntityId: 'urn:db', properties: { job: 'x' } } },
    ] })
    const { result } = renderHook(() => useRestoreGhost())
    await act(async () => { await result.current('urn:t1') })

    expect(getChangeEntriesBatch).toHaveBeenCalledWith('ws', 'g', { branchId: 'draft-1' }, ['urn:t1', 'f1'])
    const staged = useStagedChangesStore.getState().changes
    expect(staged.map((c) => [c.type, c.targetId])).toEqual([['create_entity', 'urn:t1'], ['create_edge', 'f1']])
    expect(staged[0].after).toMatchObject({ displayName: 'T1', parentUrn: 'urn:db', containmentEdgeId: 'k1' })
    expect(staged[1].after).toMatchObject({ restoreOf: 'f1', properties: { job: 'x' } })
  })

  it('says so, and stages nothing, when too much was deleted with it', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => [bare(`urn:c${i}`), link(`k${i}`, 'urn:t1', `urn:c${i}`, 'CONTAINS')]).flat()
    useBranchStore.setState({ activeChangeSet: buildChangeSet([bare('urn:t1'), ...many]) } as never)
    const { result } = renderHook(() => useRestoreGhost())
    await act(async () => { await result.current('urn:t1') })
    expect(getChangeEntriesBatch).not.toHaveBeenCalled()
    expect(useStagedChangesStore.getState().changes).toEqual([])
    expect(notify).toHaveBeenCalledWith('warning', expect.stringContaining('Too much was deleted with it'))
  })
})
