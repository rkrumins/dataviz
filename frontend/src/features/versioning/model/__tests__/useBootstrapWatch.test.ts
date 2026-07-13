/**
 * useBootstrapWatch holds the RECEIPT: when a copy finishes, the graph becomes versioned and
 * the "needs enabling" surface would otherwise vanish in the very frame the user earned the
 * integrity report. So the hook latches onto a job it watched run.
 *
 * The trap is that the drawer hosting it is NOT remounted when the user picks a different
 * data source, so anything the hook remembers must be remembered PER SOURCE. These tests pin
 * both directions of the leak that a bare boolean caused.
 */
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BootstrapJob } from '@/services/versioningApiService'

const invalidateQueries = vi.fn()
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
}))

let statusByDs: Record<string, BootstrapJob | undefined> = {}
vi.mock('../../hooks/useVersioning', () => ({
  VERSIONING_KEYS: { all: ['versioning'] },
  useBootstrapStatus: (_ws: string, ds: string | null, opts: { enabled: boolean }) => ({
    data: opts.enabled && ds ? statusByDs[ds] : undefined,
  }),
}))

const { useBootstrapWatch } = await import('../useBootstrapWatch')

const job = (over: Partial<BootstrapJob>): BootstrapJob => ({
  jobId: 'vjob_1', graphId: 'g1', status: 'running', phase: 'nodes',
  processed: 10, total: 100, percent: 10, report: null, ...over,
})

const REPORT = { checks: [], stored: { nodes: 1, edges: 1 } } as unknown as BootstrapJob['report']

beforeEach(() => {
  statusByDs = {}
  invalidateQueries.mockClear()
})

describe('the receipt belongs to whoever ran the copy', () => {
  it('shows the report to the person who watched the copy run', () => {
    statusByDs.dsA = job({ status: 'running' })
    const { result, rerender } = renderHook(
      ({ ds }) => useBootstrapWatch('ws1', ds, { headSeq: 1 }),
      { initialProps: { ds: 'dsA' } },
    )
    expect(result.current.showProgress).toBe(true)

    statusByDs.dsA = job({ status: 'completed', report: REPORT })
    rerender({ ds: 'dsA' })
    expect(result.current.showReport).toBe(true)
  })

  it('hides it once dismissed', () => {
    statusByDs.dsA = job({ status: 'running' })
    const { result, rerender } = renderHook(
      ({ ds }) => useBootstrapWatch('ws1', ds, { headSeq: 1 }),
      { initialProps: { ds: 'dsA' } },
    )
    statusByDs.dsA = job({ status: 'completed', report: REPORT })
    rerender({ ds: 'dsA' })
    result.current.dismissReport()
    rerender({ ds: 'dsA' })
    expect(result.current.showReport).toBe(false)
  })
})

describe('nothing it remembers may leak to another data source', () => {
  it("does not replay another source's OLD report as a fresh receipt", () => {
    // Watch dsA's copy finish, without dismissing it.
    statusByDs.dsA = job({ status: 'running' })
    const { result, rerender } = renderHook(
      ({ ds }) => useBootstrapWatch('ws1', ds, { headSeq: 1 }),
      { initialProps: { ds: 'dsA' } },
    )
    statusByDs.dsA = job({ status: 'completed', report: REPORT })
    rerender({ ds: 'dsA' })
    expect(result.current.showReport).toBe(true)

    // Now the user opens dsB — already versioned (headSeq 2), bootstrapped long ago. Its old
    // completed job must NOT surface as a report the user just earned.
    statusByDs.dsB = job({ jobId: 'vjob_old', status: 'completed', report: REPORT })
    rerender({ ds: 'dsB' } as { ds: string })
    expect(result.current.showReport).toBe(false)
  })

  it("does not swallow the NEXT source's real receipt because a previous one was dismissed", () => {
    statusByDs.dsA = job({ status: 'running' })
    const { result, rerender } = renderHook(
      ({ ds }) => useBootstrapWatch('ws1', ds, { headSeq: 1 }),
      { initialProps: { ds: 'dsA' } },
    )
    statusByDs.dsA = job({ status: 'completed', report: REPORT })
    rerender({ ds: 'dsA' })
    result.current.dismissReport()
    rerender({ ds: 'dsA' })
    expect(result.current.showReport).toBe(false)

    // dsB now runs its own copy. Its receipt is owed to the user regardless of dsA's.
    statusByDs.dsB = job({ status: 'running' })
    rerender({ ds: 'dsB' })
    statusByDs.dsB = job({ status: 'completed', report: REPORT })
    rerender({ ds: 'dsB' })
    expect(result.current.showReport).toBe(true)
  })
})
