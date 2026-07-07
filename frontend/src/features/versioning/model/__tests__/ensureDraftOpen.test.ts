/**
 * ensureDraftOpen — atomic open-or-resume contract via POST /resolve
 * (resolveAndOpenDraft): the active view's id is sent so the draft is
 * attributed to the view it was opened from, the server's attribution wins on
 * resume (claim-if-null happens server-side), and null means "cannot edit"
 * (unresolved context or API failure). Uses the real branchStore; the API
 * service and schema store are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/versioningApiService', () => ({
  resolveAndOpenDraft: vi.fn(),
}))

// ensureDraftOpen reads the ACTIVE view from the schema store (the same source
// the read-side filters use) — mock the store, not the whole schema machinery.
const getActiveView = vi.fn()
vi.mock('@/store/schema', () => ({
  useSchemaStore: { getState: () => ({ getActiveView }) },
}))

// ensureDraftOpen invalidates the versioning query caches through @/main's
// getQueryClient (dynamic import) — stub it, since importing the real module
// mounts the app (same precedent as useRevealNode.test.ts).
const invalidateQueries = vi.fn()
vi.mock('@/main', () => ({
  getQueryClient: () => ({ invalidateQueries }),
}))

import { resolveAndOpenDraft } from '@/services/versioningApiService'
import { useBranchStore } from '@/store/branchStore'
import { ensureDraftOpen } from '../ensureDraftOpen'

const resolveAndOpenDraftMock = vi.mocked(resolveAndOpenDraft)

beforeEach(() => {
  vi.clearAllMocks()
  getActiveView.mockReturnValue({ id: 'view1' })
  useBranchStore.getState().reset()
  useBranchStore.setState({
    workspaceId: 'ws1',
    dataSourceId: 'ds1',
    graphId: 'g1',
    mainBranchId: 'br_main',
  })
})

describe('ensureDraftOpen', () => {
  it('is a no-op returning the current branch when already in a draft', async () => {
    useBranchStore.setState({ currentBranchId: 'br_open' })

    await expect(ensureDraftOpen()).resolves.toBe('br_open')
    expect(resolveAndOpenDraftMock).not.toHaveBeenCalled()
  })

  it('opens-or-resumes atomically, sending the active view id for attribution', async () => {
    resolveAndOpenDraftMock.mockResolvedValue({
      graphId: 'g1',
      mainBranchId: 'br_main',
      mainHeadCommitSeq: 5,
      myDraft: { branchId: 'br_mine', originatingViewId: 'view1' },
    })

    await expect(ensureDraftOpen()).resolves.toBe('br_mine')
    expect(resolveAndOpenDraftMock).toHaveBeenCalledWith('ws1', {
      dataSourceId: 'ds1',
      originatingViewId: 'view1',
    })
    expect(useBranchStore.getState().currentBranchId).toBe('br_mine')
    expect(useBranchStore.getState().originatingViewId).toBe('view1')
  })

  it("keeps the server's attribution when resuming a draft opened from another view", async () => {
    resolveAndOpenDraftMock.mockResolvedValue({
      graphId: 'g1',
      mainBranchId: 'br_main',
      mainHeadCommitSeq: 5,
      myDraft: { branchId: 'br_mine', originatingViewId: 'viewOther' },
    })

    await expect(ensureDraftOpen()).resolves.toBe('br_mine')
    expect(useBranchStore.getState().originatingViewId).toBe('viewOther')
  })

  it('falls back to the branch-store view id when no active view exists', async () => {
    getActiveView.mockReturnValue(undefined)
    useBranchStore.setState({ originatingViewId: 'viewStored' })
    resolveAndOpenDraftMock.mockResolvedValue({
      graphId: 'g1',
      mainBranchId: 'br_main',
      mainHeadCommitSeq: 5,
      myDraft: { branchId: 'br_new', originatingViewId: null },
    })

    await expect(ensureDraftOpen()).resolves.toBe('br_new')
    expect(resolveAndOpenDraftMock).toHaveBeenCalledWith('ws1', {
      dataSourceId: 'ds1',
      originatingViewId: 'viewStored',
    })
    expect(useBranchStore.getState().originatingViewId).toBe('viewStored')
  })

  it('returns null when the graph context is not resolved yet', async () => {
    useBranchStore.setState({ graphId: null })

    await expect(ensureDraftOpen()).resolves.toBeNull()
    expect(resolveAndOpenDraftMock).not.toHaveBeenCalled()
  })

  it('returns null when the response carries no draft', async () => {
    resolveAndOpenDraftMock.mockResolvedValue({
      graphId: 'g1',
      mainBranchId: 'br_main',
      mainHeadCommitSeq: 5,
      myDraft: null,
    })

    await expect(ensureDraftOpen()).resolves.toBeNull()
    expect(useBranchStore.getState().currentBranchId).toBeNull()
  })

  it('returns null when the API fails (missing :manage or transient error)', async () => {
    resolveAndOpenDraftMock.mockRejectedValue(new Error('403'))

    await expect(ensureDraftOpen()).resolves.toBeNull()
    expect(useBranchStore.getState().currentBranchId).toBeNull()
  })
})
