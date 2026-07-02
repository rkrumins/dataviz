/**
 * ensureDraftOpen — resume-before-create contract: an existing draft reported
 * by resolveGraph is switched to (never duplicated), a fresh draft is opened
 * only when none exists, and null means "cannot edit" (unresolved context or
 * API failure). Uses the real branchStore; only the API service is mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/versioningApiService', () => ({
  resolveGraph: vi.fn(),
  openDraft: vi.fn(),
}))

import { openDraft, resolveGraph } from '@/services/versioningApiService'
import { useBranchStore } from '@/store/branchStore'
import { ensureDraftOpen } from '../ensureDraftOpen'

const resolveGraphMock = vi.mocked(resolveGraph)
const openDraftMock = vi.mocked(openDraft)

beforeEach(() => {
  vi.clearAllMocks()
  useBranchStore.getState().reset()
  useBranchStore.setState({
    workspaceId: 'ws1',
    dataSourceId: 'ds1',
    graphId: 'g1',
    mainBranchId: 'br_main',
    originatingViewId: 'view1',
  })
})

describe('ensureDraftOpen', () => {
  it('is a no-op returning the current branch when already in a draft', async () => {
    useBranchStore.setState({ currentBranchId: 'br_open' })

    await expect(ensureDraftOpen()).resolves.toBe('br_open')
    expect(resolveGraphMock).not.toHaveBeenCalled()
    expect(openDraftMock).not.toHaveBeenCalled()
  })

  it('resumes the existing draft reported by resolveGraph instead of opening a duplicate', async () => {
    resolveGraphMock.mockResolvedValue({
      graphId: 'g1',
      mainBranchId: 'br_main',
      mainHeadCommitSeq: 5,
      myDraft: { branchId: 'br_mine' },
    })

    await expect(ensureDraftOpen()).resolves.toBe('br_mine')
    expect(openDraftMock).not.toHaveBeenCalled()
    expect(useBranchStore.getState().currentBranchId).toBe('br_mine')
    expect(useBranchStore.getState().originatingViewId).toBe('view1')
  })

  it('opens a new draft when the user has none', async () => {
    resolveGraphMock.mockResolvedValue({
      graphId: 'g1',
      mainBranchId: 'br_main',
      mainHeadCommitSeq: 5,
      myDraft: null,
    })
    openDraftMock.mockResolvedValue({ branchId: 'br_new' })

    await expect(ensureDraftOpen()).resolves.toBe('br_new')
    expect(openDraftMock).toHaveBeenCalledWith('ws1', 'g1', { originatingViewId: 'view1' })
    expect(useBranchStore.getState().currentBranchId).toBe('br_new')
  })

  it('returns null when the graph context is not resolved yet', async () => {
    useBranchStore.setState({ graphId: null })

    await expect(ensureDraftOpen()).resolves.toBeNull()
    expect(resolveGraphMock).not.toHaveBeenCalled()
    expect(openDraftMock).not.toHaveBeenCalled()
  })

  it('returns null when the API fails (missing :manage or transient error)', async () => {
    resolveGraphMock.mockRejectedValue(new Error('403'))

    await expect(ensureDraftOpen()).resolves.toBeNull()
    expect(useBranchStore.getState().currentBranchId).toBeNull()
  })
})
