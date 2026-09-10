/**
 * A save must never come back claiming more than it did.
 *
 * `stagedChangesToOps` drops a node update whose mapped payload is empty, and this function
 * short-circuits a batch with zero ops without calling the backend at all — so an edit the mapper
 * cannot carry produced a resolved promise indistinguishable from a real commit, and the canvas
 * put a green "Saved to draft." over it. The return now names the fields that never left the
 * browser, so the caller can say what actually happened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/services/versioningApiService', () => ({ applyGraphChanges: vi.fn() }))
vi.mock('@/hooks/useAggregatedLineage', () => ({ invalidateAggregatedEdges: vi.fn() }))

import { saveStagedChangesToDraft } from '../saveStagedChangesToDraft'
import { applyGraphChanges } from '@/services/versioningApiService'
import type { StagedChange } from '@/store/stagedChangesStore'

const mockApply = vi.mocked(applyGraphChanges)
const target = { wsId: 'w', dataSourceId: 'ds', branchId: 'b', provider: {} as never }
const sc = (over: Partial<StagedChange>): StagedChange => ({
  id: 'c', type: 'update_entity', targetId: 't', after: {}, summary: '', timestamp: 0, ...over,
})

describe('saveStagedChangesToDraft — what it reports it saved', () => {
  beforeEach(() => {
    mockApply.mockReset()
    mockApply.mockResolvedValue({ commitId: 'x', assigned: {} } as never)
  })

  it('an edit to ONLY unmappable fields makes no request AND is reported, not swallowed', async () => {
    const res = await saveStagedChangesToDraft(
      [sc({ targetUrn: 'urn:a', before: { retentionDays: 30 }, after: { retentionDays: 90 } })],
      target,
    )
    expect(mockApply).not.toHaveBeenCalled()
    expect(res.commitId).toBeNull()
    expect(res.unsaved).toEqual(['retentionDays'])
  })

  it('a description edit now reaches the backend and reports nothing unsaved', async () => {
    const res = await saveStagedChangesToDraft(
      [sc({ targetUrn: 'urn:b', before: { description: '' }, after: { description: 'why this exists' } })],
      target,
    )
    expect(mockApply).toHaveBeenCalledTimes(1)
    expect(mockApply.mock.calls[0][3]).toEqual([
      { op: 'update', kind: 'node', id: 'urn:b', payload: { description: 'why this exists' } },
    ])
    expect(res.unsaved).toEqual([])
  })

  it('a partly-carried edit commits AND still names the field it left behind', async () => {
    const res = await saveStagedChangesToDraft(
      [sc({ targetUrn: 'urn:c', before: { description: '', owner: 'ana' }, after: { description: 'd', owner: 'bo' } })],
      target,
    )
    expect(mockApply).toHaveBeenCalledTimes(1)
    expect(res.commitId).toBe('x')
    expect(res.unsaved).toEqual(['owner'])
  })

  it('a layer-only save is still an honest empty answer — view config, nothing lost', async () => {
    const res = await saveStagedChangesToDraft(
      [sc({ type: 'assign_layer', targetId: 'urn:x', targetUrn: 'urn:x', after: { layerId: 'warehouse' } })],
      target,
    )
    expect(mockApply).not.toHaveBeenCalled()
    expect(res.commitId).toBeNull()
    expect(res.unsaved).toEqual([])
  })

  it('collects the unsaved fields across the whole batch, deduped', async () => {
    const res = await saveStagedChangesToDraft(
      [
        sc({ targetUrn: 'urn:d', before: { owner: 'ana' }, after: { owner: 'bo' } }),
        sc({ targetUrn: 'urn:e', before: { owner: 'ana', steward: 'x' }, after: { owner: 'cy', steward: 'y' } }),
      ],
      target,
    )
    expect(res.unsaved).toEqual(['owner', 'steward'])
  })
})
