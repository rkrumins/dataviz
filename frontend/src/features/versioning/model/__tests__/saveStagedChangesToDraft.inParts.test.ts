/**
 * A save past what one request carries goes in parts — its ops uploaded, written as one commit by a
 * job — under the same Idempotency-Key a one-request save would use; a small one goes as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/versioningApiService')>(),
  applyGraphChanges: vi.fn(),
  saveGraphChangesInParts: vi.fn(),
  SAVE_IN_PARTS_ABOVE: 2,
}))
vi.mock('@/services/viewTransferApiService', () => ({ newRequestId: () => 'key-1' }))
vi.mock('@/hooks/useAggregatedLineage', () => ({ invalidateAggregatedEdges: vi.fn() }))

import { saveStagedChangesToDraft } from '../saveStagedChangesToDraft'
import { applyGraphChanges, saveGraphChangesInParts } from '@/services/versioningApiService'
import { useBranchStore } from '@/store/branchStore'
import { useSaveProgressStore } from '@/store/saveProgressStore'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'

const target = { wsId: 'w', dataSourceId: 'ds', branchId: 'b', provider: {} as never, message: 'm' }
const rename = (urn: string): StagedChange => ({
  id: `c-${urn}`, type: 'update_entity', targetId: urn, targetUrn: urn,
  before: { description: '' }, after: { description: urn }, summary: '', timestamp: 0,
})

beforeEach(() => {
  vi.mocked(applyGraphChanges).mockReset().mockResolvedValue({ commitId: 'c', assigned: {} } as never)
  vi.mocked(saveGraphChangesInParts).mockReset().mockImplementation(async (...args) => {
    args[6]?.({ phase: 'saving' })
    expect(useSaveProgressStore.getState().progress).toEqual({ phase: 'saving' })
    return { commitId: 'c', assigned: {} } as never
  })
  useStagedChangesStore.setState({ _scopeKey: null, _byScope: {}, changes: [], redoStack: [] })
  useBranchStore.setState({ graphId: 'g1' } as never)
})

describe('saveStagedChangesToDraft — in parts', () => {
  it('sends a save past one request in parts, under the same key', async () => {
    await saveStagedChangesToDraft(['urn:a', 'urn:b', 'urn:c'].map(rename), target)
    expect(applyGraphChanges).not.toHaveBeenCalled()
    const [ws, graph, branch, ops, message, key] = vi.mocked(saveGraphChangesInParts).mock.calls[0]
    expect([ws, graph, branch, ops.length, message, key]).toEqual(['w', 'g1', 'b', 3, 'm', 'key-1'])
    expect(useSaveProgressStore.getState().progress).toBeNull()      // cleared once it ends
  })

  it('sends a small save in one request, as before', async () => {
    await saveStagedChangesToDraft(['urn:a'].map(rename), target)
    expect(saveGraphChangesInParts).not.toHaveBeenCalled()
    expect(applyGraphChanges).toHaveBeenCalledWith('w', 'ds', 'b', expect.any(Array), 'm', 'key-1')
  })
})
