/**
 * When a property operation on the draft finishes, the bar says so — what it did, with the way to
 * review it — and refreshes the draft's reads (every versioning read, and the canvas's graph
 * reads). An operation it never saw running (finished before this canvas opened) is not announced.
 */
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { describe, it, expect, vi } from 'vitest'

import type { PropertyOpJob, PropertyOpList } from '@/services/versioningApiService'

const notify = vi.fn()
const bumpMainEpoch = vi.fn()
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/store/branchStore', () => ({
  useBranchStore: (sel: (s: unknown) => unknown) => sel({ bumpMainEpoch }),
  useEffectiveBranchId: () => null,
}))

import { usePropertyOpCompletion } from '../usePropertyOpCompletion'
import { VERSIONING_KEYS } from '../useVersioning'

const op = (status: PropertyOpJob['status'], extra: Partial<PropertyOpJob> = {}) => ({
  jobId: 'j1', kind: 'apply', status, op: { kind: 'set', key: 'owner', value: 'alice' },
  summary: { applied: 3, commits: ['c1'] }, error: null, ...extra,
}) as PropertyOpJob
const list = (...ops: PropertyOpJob[]): PropertyOpList => ({ ops, draftChanges: 3, maxDraftChanges: 100_000 })

function setup(initial: PropertyOpList) {
  const qc = new QueryClient()
  const invalidate = vi.spyOn(qc, 'invalidateQueries')
  const onReview = vi.fn()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  const hook = renderHook(({ l }) => usePropertyOpCompletion(l, onReview), {
    wrapper, initialProps: { l: initial },
  })
  return { ...hook, invalidate, onReview }
}

describe('usePropertyOpCompletion', () => {
  it('announces an operation it saw running once it completes, and refreshes the draft', () => {
    notify.mockReset(); bumpMainEpoch.mockReset()
    const { rerender, invalidate, onReview } = setup(list(op('running')))
    expect(notify).not.toHaveBeenCalled()
    rerender({ l: list(op('completed')) })
    expect(notify).toHaveBeenCalledWith('success', 'Set owner = alice — 3 entities changed',
      expect.objectContaining({ label: 'Review changes' }))
    notify.mock.calls[0][2].onClick()
    expect(onReview).toHaveBeenCalled()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: VERSIONING_KEYS.all })
    expect(bumpMainEpoch).toHaveBeenCalledTimes(1)
  })

  it('says why an operation stopped short', () => {
    notify.mockReset()
    const { rerender } = setup(list(op('running')))
    rerender({ l: list(op('failed', { error: 'The draft was discarded while the operation ran.' })) })
    expect(notify).toHaveBeenCalledWith('error',
      "Set owner = alice didn't finish: The draft was discarded while the operation ran.")
  })

  it('leaves an operation that finished before it was watched unannounced', () => {
    notify.mockReset(); bumpMainEpoch.mockReset()
    const { rerender } = setup(list(op('completed')))
    rerender({ l: list(op('completed')) })
    expect(notify).not.toHaveBeenCalled()
    expect(bumpMainEpoch).not.toHaveBeenCalled()
  })
})
