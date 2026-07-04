/**
 * Layer moves must persist WITHOUT ever endangering the user's structural edits.
 * These tests pin the two safety guarantees of Phase 3 in saveStagedChangesToDraft:
 *   1. a layer move persists as an isolated node `update` (its own commit), and
 *   2. a failure of that layer commit is non-fatal — it never throws, so the
 *      already-committed creates/renames/containment edits are safe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/services/versioningApiService', () => ({ applyGraphChanges: vi.fn() }))
vi.mock('@/hooks/useAggregatedLineage', () => ({ invalidateAggregatedEdges: vi.fn() }))

import { saveStagedChangesToDraft } from '../saveStagedChangesToDraft'
import { applyGraphChanges } from '@/services/versioningApiService'
import type { StagedChange } from '@/store/stagedChangesStore'

const mockApply = vi.mocked(applyGraphChanges)

const target = { wsId: 'w', dataSourceId: 'ds', branchId: 'b', provider: {} as any }
const sc = (over: Partial<StagedChange>): StagedChange => ({
  id: 'c', type: 'assign_layer', targetId: 't', after: {}, summary: '', timestamp: 0, ...over,
})

describe('saveStagedChangesToDraft — isolated layer-move persistence (Phase 3)', () => {
  beforeEach(() => {
    mockApply.mockReset()
    mockApply.mockResolvedValue({ commitId: 'x' } as any)
  })

  it('persists an assign_layer as a separate node-update commit (layerAssignment)', async () => {
    await saveStagedChangesToDraft(
      [sc({ type: 'assign_layer', targetId: 'urn:x', targetUrn: 'urn:x', after: { layerId: 'warehouse' } })],
      target,
    )
    expect(mockApply).toHaveBeenCalledTimes(1) // no structural ops → only the layer commit
    const layerOps = mockApply.mock.calls[0][3]
    expect(layerOps).toEqual([{ op: 'update', kind: 'node', id: 'urn:x', payload: { layerAssignment: 'warehouse' } }])
  })

  it('sends layer moves in a SEPARATE commit from structural edits', async () => {
    await saveStagedChangesToDraft(
      [
        sc({ type: 'rename_entity', targetId: 'urn:a', targetUrn: 'urn:a', after: { label: 'A' } }),
        sc({ type: 'assign_layer', targetId: 'urn:x', targetUrn: 'urn:x', after: { layerId: 'warehouse' } }),
      ],
      target,
    )
    expect(mockApply).toHaveBeenCalledTimes(2)
    // 1st call = structural (rename), 2nd = isolated layer commit.
    expect(mockApply.mock.calls[0][3]).toEqual([
      { op: 'update', kind: 'node', id: 'urn:a', payload: { displayName: 'A' } },
    ])
    expect(mockApply.mock.calls[1][3]).toEqual([
      { op: 'update', kind: 'node', id: 'urn:x', payload: { layerAssignment: 'warehouse' } },
    ])
  })

  it('a layer-commit failure is NON-FATAL — structural commit succeeded, save resolves', async () => {
    mockApply
      .mockResolvedValueOnce({ commitId: 'structural' } as any) // structural commit OK
      .mockRejectedValueOnce(new Error('layer boom'))            // layer commit fails
    await expect(
      saveStagedChangesToDraft(
        [
          sc({ type: 'rename_entity', targetId: 'urn:a', targetUrn: 'urn:a', after: { label: 'A' } }),
          sc({ type: 'assign_layer', targetId: 'urn:x', targetUrn: 'urn:x', after: { layerId: 'warehouse' } }),
        ],
        target,
      ),
    ).resolves.toEqual({ commitId: 'structural' })
    expect(mockApply).toHaveBeenCalledTimes(2)
  })

  it('skips logical/pseudo nodes (no backend entity to update)', async () => {
    await saveStagedChangesToDraft(
      [sc({ type: 'assign_layer', targetId: 'logical:group-1', after: { layerId: 'warehouse' } })],
      target,
    )
    expect(mockApply).not.toHaveBeenCalled()
  })
})
