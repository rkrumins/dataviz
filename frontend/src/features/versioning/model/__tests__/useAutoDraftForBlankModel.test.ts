/**
 * useAutoDraftForBlankModel — a fresh blank model auto-opens the caller's draft
 * exactly once per graph per session; every other graph kind/state is untouched.
 */
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ensureDraftOpen, useResolveGraph, usePermission, useEffectiveBranchId } = vi.hoisted(() => ({
  ensureDraftOpen: vi.fn(async () => 'b1'),
  useResolveGraph: vi.fn(),
  usePermission: vi.fn(() => true),
  useEffectiveBranchId: vi.fn<() => string | null>(() => null),
}))

vi.mock('../ensureDraftOpen', () => ({ ensureDraftOpen }))
vi.mock('../../hooks/useVersioning', () => ({ useResolveGraph }))
vi.mock('@/store/auth', () => ({ usePermission }))
vi.mock('@/store/branchStore', () => ({
  useEffectiveBranchId,
  useBranchStore: (sel: (s: { graphId: string | null }) => unknown) => sel({ graphId: 'g1' }),
}))

import { useAutoDraftForBlankModel } from '../useAutoDraftForBlankModel'

const resolved = (kind: string, mainHeadCommitSeq: number, graphId = 'g1') => ({
  data: { graphId, kind, mainHeadCommitSeq },
})

describe('useAutoDraftForBlankModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    usePermission.mockReturnValue(true)
    useEffectiveBranchId.mockReturnValue(null)
  })

  it('opens a draft for a fresh blank model', () => {
    useResolveGraph.mockReturnValue(resolved('blank', 1))
    renderHook(() => useAutoDraftForBlankModel('ws1', 'ds1'))
    expect(ensureDraftOpen).toHaveBeenCalledTimes(1)
  })

  it('is one-shot per graph per session', () => {
    useResolveGraph.mockReturnValue(resolved('blank', 1))
    const first = renderHook(() => useAutoDraftForBlankModel('ws1', 'ds1'))
    first.unmount()
    renderHook(() => useAutoDraftForBlankModel('ws1', 'ds1'))
    expect(ensureDraftOpen).toHaveBeenCalledTimes(1)
  })

  it('ignores non-blank graphs', () => {
    useResolveGraph.mockReturnValue(resolved('manual', 1))
    renderHook(() => useAutoDraftForBlankModel('ws1', 'ds1'))
    expect(ensureDraftOpen).not.toHaveBeenCalled()
  })

  it('ignores blank models that already published (mainHead > 1)', () => {
    useResolveGraph.mockReturnValue(resolved('blank', 4))
    renderHook(() => useAutoDraftForBlankModel('ws1', 'ds1'))
    expect(ensureDraftOpen).not.toHaveBeenCalled()
  })

  it('ignores read-only users and already-open drafts', () => {
    useResolveGraph.mockReturnValue(resolved('blank', 1))
    usePermission.mockReturnValue(false)
    renderHook(() => useAutoDraftForBlankModel('ws1', 'ds1'))
    expect(ensureDraftOpen).not.toHaveBeenCalled()

    usePermission.mockReturnValue(true)
    useEffectiveBranchId.mockReturnValue('b-existing')
    renderHook(() => useAutoDraftForBlankModel('ws1', 'ds1'))
    expect(ensureDraftOpen).not.toHaveBeenCalled()
  })
})
