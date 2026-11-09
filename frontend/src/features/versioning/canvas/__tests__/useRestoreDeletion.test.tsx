/**
 * useRestoreDeletion — a published deletion back into the person's draft: the entity, what went
 * with it and its links, each under its own id, staged parent-first in the draft's own slice (never
 * Published's), then Review. The draft is asked first whether it can take it; when it can't, it says
 * why and nothing is staged.
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ getDeletionCascade: vi.fn(), ensureDraftOpen: vi.fn(), notify: vi.fn() }))
vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()),
  getDeletionCascade: h.getDeletionCascade,
}))
vi.mock('../../model/ensureDraftOpen', () => ({ ensureDraftOpen: h.ensureDraftOpen }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: h.notify }) }))

import { queryClient } from '@/lib/queryClient'
import { useBranchStore } from '@/store/branchStore'
import { useSchemaStore } from '@/store/schema'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import type { TombstoneTarget } from '../../components/TombstoneDetails'
import { useRestoreDeletion } from '../useRestoreGhost'

const target: TombstoneTarget = { wsId: 'ws', graphId: 'g', entityId: 'e-orders', kind: 'node', origin: { fromSeq: 41, toSeq: 42 } }
const node = (entityId: string, urn: string, displayName: string) =>
  ({ entityId, urn, kind: 'node', status: 'removed', before: { displayName, entityType: 'Table' }, after: null })
const link = (entityId: string, edgeType: string, sourceUrn: string, targetUrn: string, properties?: Record<string, unknown>) =>
  ({ entityId, kind: 'edge', status: 'removed', after: null, sourceUrn, targetUrn,
     before: { edgeType, sourceEntityId: sourceUrn, targetEntityId: targetUrn, ...(properties ? { properties } : {}) } })
const cascade = (over: Record<string, unknown> = {}) => ({
  origin: { fromSeq: 41, toSeq: 42 }, root: 'e-orders', total: { nodes: 2, links: 4 }, restorable: true,
  live: ['urn:sales', 'urn:revenue'], skippedLinks: ['f-gone'],
  removed: [
    node('e-orders', 'urn:orders', 'orders'), node('e-id', 'urn:orders.id', 'order_id'),
    link('k0', 'CONTAINS', 'urn:sales', 'urn:orders'), link('k1', 'CONTAINS', 'urn:orders', 'urn:orders.id'),
    link('f1', 'FLOWS_TO', 'urn:orders.id', 'urn:revenue', { job: 'nightly' }),
    link('f-gone', 'FLOWS_TO', 'urn:orders', 'urn:gone'),
  ],
  ...over,
})
const restore = async () => {
  const { result } = renderHook(() => useRestoreDeletion())
  await act(async () => { await result.current(target, 'orders') })
}

beforeEach(() => {
  queryClient.clear()
  Object.values(h).forEach((f) => f.mockReset())
  h.ensureDraftOpen.mockResolvedValue('d1')
  h.getDeletionCascade.mockResolvedValue(cascade())
  useSchemaStore.setState({ schema: { containmentEdgeTypes: ['CONTAINS'] } } as never)
  useBranchStore.setState({ workspaceId: 'ws', dataSourceId: 'ds', graphId: 'g', revision: { seq: 41, headAtOpen: 50 } } as never)
  useStagedChangesStore.setState({ changes: [], redoStack: [], _scopeKey: 'ws::ds::main', _byScope: {}, isReviewPanelOpen: false } as never)
})

describe('useRestoreDeletion', () => {
  it('brings it back whole into the draft, each under its own id, then opens Review', async () => {
    await restore()
    expect(useBranchStore.getState().revision).toBeNull()                    // back to the graph as it is now
    expect(h.getDeletionCascade).toHaveBeenCalledWith('ws', 'g', 'e-orders', { fromSeq: 41, toSeq: 42 }, 'd1')
    const s = useStagedChangesStore.getState()
    expect(s._scopeKey).toBe('ws::ds::d1')
    expect(s.changes.map((c) => [c.type, c.targetId])).toEqual([
      ['create_entity', 'urn:orders'], ['create_entity', 'urn:orders.id'], ['create_edge', 'f1'],
    ])
    expect(s.changes[0].after).toMatchObject({ parentUrn: 'urn:sales', containmentEdgeId: 'k0' })
    expect(s.changes[1].after).toMatchObject({ parentUrn: 'urn:orders', containmentEdgeId: 'k1' })
    expect(s.changes[2].after).toMatchObject({ restoreOf: 'f1', properties: { job: 'nightly' } })
    expect(s.isReviewPanelOpen).toBe(true)
    expect(h.notify).toHaveBeenCalledWith('success',
      'Restored ‘orders’ with the 1 entity and 1 relationship deleted with it into your draft. Review and save to keep it.')
  })

  it.each([
    ['parent_gone', { detail: { parentId: 'e-sales', parentName: 'Sales' } }, 'Restore ‘Sales’ first: your draft no longer has it.'],
    ['draft_predates', {}, 'Pull the latest from Published into your draft first: it still has ‘orders’.'],
    ['recreated', {}, 'Your draft has ‘orders’, or something deleted with it, again: there is nothing to restore.'],
    ['too_large', {}, 'Too much went with ‘orders’ to restore it here. Undo the change that deleted it in History instead.'],
  ])('says why when the draft can’t take it (%s), and stages nothing', async (reason, extra, message) => {
    h.getDeletionCascade.mockResolvedValue(cascade({ restorable: false, reason, removed: [], ...extra }))
    await restore()
    expect(h.notify).toHaveBeenCalledWith('warning', message)
    expect(useStagedChangesStore.getState().changes).toEqual([])
    expect(useStagedChangesStore.getState().isReviewPanelOpen).toBe(false)
  })

  it('asks nothing without a draft to restore into', async () => {
    h.ensureDraftOpen.mockResolvedValue(null)
    await restore()
    expect(h.getDeletionCascade).not.toHaveBeenCalled()
    expect(useStagedChangesStore.getState().changes).toEqual([])
  })
})
