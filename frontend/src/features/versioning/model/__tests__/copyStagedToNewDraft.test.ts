/**
 * copyStagedToNewDraft — unsaved edits on a draft that closed under them are carried to a fresh
 * draft through the staged-draft snapshot, so the restore that follows a refresh lays them onto the
 * new draft's canvas. Uses the real branch, staged-changes and canvas stores; the API is mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/versioningApiService', () => ({
  openDraft: vi.fn(),
}))

const invalidateQueries = vi.fn()
vi.mock('@/lib/queryClient', () => ({
  getQueryClient: () => ({ invalidateQueries }),
}))

import { openDraft } from '@/services/versioningApiService'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { readSnapshot, writeSnapshot } from '@/features/canvas-drafts/stagedDraftPersistence'
import { copyStagedToNewDraft } from '../copyStagedToNewDraft'

const openDraftMock = vi.mocked(openDraft)

const OLD = 'ws1::ds1::br_old'
const NEW = 'ws1::ds1::br_new'

const change: StagedChange = {
  id: 'c1', type: 'create_entity', targetId: 'tmp_1', after: { displayName: 'A' },
  summary: 'Create A', timestamp: 1,
} as StagedChange

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  openDraftMock.mockResolvedValue({ branchId: 'br_new' })
  useBranchStore.getState().reset()
  useBranchStore.setState({ workspaceId: 'ws1', dataSourceId: 'ds1', graphId: 'g1', currentBranchId: 'br_old' })
  useCanvasStore.setState({ nodes: [], edges: [] })
  useStagedChangesStore.setState({ _scopeKey: OLD, _byScope: {}, changes: [change], redoStack: [] })
})

describe('copyStagedToNewDraft', () => {
  it('opens a draft from the view and moves the staged work to its snapshot', async () => {
    writeSnapshot({
      version: 1, scopeKey: OLD, branchId: 'br_old', phase: 'staged', savedAt: 0,
      changes: [], pendingNodes: [], pendingEdges: [],
    })

    await expect(copyStagedToNewDraft('br_old', 'view1')).resolves.toBe('br_new')

    expect(openDraftMock).toHaveBeenCalledWith('ws1', 'g1', { originatingViewId: 'view1' })
    const copied = readSnapshot(NEW)
    expect(copied).toMatchObject({ scopeKey: NEW, branchId: 'br_new', phase: 'staged' })
    expect(copied!.changes.map((c) => c.id)).toEqual(['c1'])
    expect(localStorage.getItem(`synodic:staged-draft:${OLD}`)).toBeNull()
    expect(useBranchStore.getState().currentBranchId).toBe('br_new')
    expect(useBranchStore.getState().originatingViewId).toBe('view1')
    await vi.waitFor(() => expect(invalidateQueries).toHaveBeenCalled())
  })

  it('copies from the closed draft’s snapshot after the canvas has moved to Published', async () => {
    // useActiveBranchGuard ejected: the active slice is Published's, the closed draft's edits
    // are parked and still in its own snapshot.
    useBranchStore.setState({ currentBranchId: null })
    useStagedChangesStore.setState({ _scopeKey: 'ws1::ds1::main', changes: [], redoStack: [] })
    writeSnapshot({
      version: 1, scopeKey: OLD, branchId: 'br_old', phase: 'staged', savedAt: 0,
      changes: [{ id: 'c9', type: 'create_entity', targetId: 'tmp_9', after: {}, summary: 'Create B', timestamp: 2 }],
      pendingNodes: [], pendingEdges: [],
    })

    await copyStagedToNewDraft('br_old', null)

    expect(openDraftMock).toHaveBeenCalledWith('ws1', 'g1', { originatingViewId: undefined })
    expect(readSnapshot(NEW)).toMatchObject({ branchId: 'br_new', changes: [expect.objectContaining({ id: 'c9' })] })
    expect(readSnapshot(OLD)).toBeNull()
  })

  it('opens no draft when there is nothing to copy', async () => {
    useStagedChangesStore.setState({ _scopeKey: 'ws1::ds1::main', changes: [], redoStack: [] })

    await expect(copyStagedToNewDraft('br_old', null)).rejects.toThrow()
    expect(openDraftMock).not.toHaveBeenCalled()
    expect(useBranchStore.getState().currentBranchId).toBe('br_old')
  })
})
