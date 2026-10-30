/**
 * useBranchFreshness — the draft poll:
 *   • the first poll learns the draft's head; later ones ask what others saved since the head its
 *     reader last caught up with, until they catch up again;
 *   • every 10 s while the draft (or main) is moving, every 60 s once it has been still for two
 *     minutes. A hidden tab doesn't poll at all (react-query's default).
 */
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'

vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getBranchFreshness: vi.fn(),
}))

import { getBranchFreshness } from '@/services/versioningApiService'
import { freshnessPollInterval, markDraftCaughtUp, useBranchFreshness } from '../useVersioning'

const poll = (headCommitSeq: number) => ({
  behind: false, behindBy: 0, mainHeadCommitSeq: 3, baseCommitSeq: 3, status: 'open', headCommitSeq,
})

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
)

describe('useBranchFreshness', () => {
  beforeEach(() => vi.mocked(getBranchFreshness).mockReset())

  it('asks what others saved since the head its reader last caught up with', async () => {
    vi.mocked(getBranchFreshness).mockResolvedValue(poll(7))
    const { result, rerender } = renderHook(() => useBranchFreshness('ws1', 'g1', 'br_fresh'), { wrapper })
    await waitFor(() => expect(result.current.data?.headCommitSeq).toBe(7))
    expect(vi.mocked(getBranchFreshness).mock.calls[0][3]).toBeNull()        // learns the head first

    await result.current.refetch()
    expect(vi.mocked(getBranchFreshness).mock.calls[1][3]).toBe(7)           // others' since then

    markDraftCaughtUp('br_fresh', 9)
    await result.current.refetch()
    rerender()
    expect(vi.mocked(getBranchFreshness).mock.calls[2][3]).toBe(9)
  })
})

describe('freshnessPollInterval', () => {
  it('polls every 10 s while things move, every 60 s once still for two minutes', () => {
    expect(freshnessPollInterval(1_000_000, 1_000_000 + 30_000)).toBe(10_000)
    expect(freshnessPollInterval(1_000_000, 1_000_000 + 119_000)).toBe(10_000)
    expect(freshnessPollInterval(1_000_000, 1_000_000 + 121_000)).toBe(60_000)
  })
})
