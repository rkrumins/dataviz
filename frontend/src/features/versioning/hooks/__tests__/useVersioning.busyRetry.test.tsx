/**
 * The change lists, the history and a revision's plan ask a server too busy to prepare them again:
 * up to three more times, each after its Retry-After held to 1–10 s, plus up to half a second so
 * readers don't ask in step. Nothing else is asked again — a missing revision, a failed read, a
 * change too large for its tree are answers.
 */
import React from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getChangeSummary: vi.fn(), getChangeEntries: vi.fn(), getChangeEntry: vi.fn(), getChangeIndex: vi.fn(),
  getCommitLog: vi.fn(), getHistoryMonths: vi.fn(), getRevision: vi.fn(),
}))
vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()), ...api,
}))
vi.mock('@/hooks/useAggregatedLineage', () => ({ invalidateAggregatedEdges: vi.fn() }))
vi.mock('@/providers/providerPool', () => ({ releaseProviderCaches: vi.fn(() => 0) }))

import { BusyError, DiffTooLargeError } from '@/services/versioningApiService'
import {
  BUSY_RETRY, useChangeEntries, useChangeEntry, useChangeIndex, useChangeSummary, useHistoryMonths,
  useHistoryPages, useRevision,
} from '../useVersioning'

const window_ = { fromSeq: 3, toSeq: 9 }
const HOOKS: Array<[string, keyof typeof api, () => { data?: unknown; isError: boolean }]> = [
  ['a change list summary', 'getChangeSummary', () => useChangeSummary('ws1', 'g1', window_)],
  ['a page of a change list', 'getChangeEntries', () => useChangeEntries('ws1', 'g1', window_)],
  ['one change', 'getChangeEntry', () => useChangeEntry('ws1', 'g1', window_, 'n1')],
  ['a change index', 'getChangeIndex', () => useChangeIndex('ws1', 'g1', window_, 20_000)],
  ['a page of history', 'getCommitLog', () => useHistoryPages('ws1', 'g1', { kind: 'graph' })],
  ['the history calendar', 'getHistoryMonths', () => useHistoryMonths('ws1', 'g1')],
  ["a revision's plan", 'getRevision', () => useRevision('ws1', 'g1', 12)],
]

function render<T>(hook: () => T) {
  const qc = new QueryClient()
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return renderHook(hook, { wrapper })
}

const elapse = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
// React Query tells its observers on a timer of its own, which the fake clock holds too.
const settle = () => elapse(10)

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  for (const fn of Object.values(api)) fn.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('BUSY_RETRY', () => {
  it('asks a busy server again three more times, and nothing else again', () => {
    const busy = new BusyError('change_list_busy', 5_000)
    expect([0, 1, 2, 3].map((n) => BUSY_RETRY.retry(n, busy))).toEqual([true, true, true, false])
    for (const err of [
      Object.assign(new Error('no revision 12'), { status: 404 }),
      Object.assign(new Error('the database is unavailable'), { status: 503 }),
      new DiffTooLargeError(300_000, 100_000),
      new TypeError('Failed to fetch'),
    ]) expect(BUSY_RETRY.retry(0, err)).toBe(false)
  })

  it('waits its Retry-After, held to 1–10 s, plus up to half a second', () => {
    const wait = (retryAfterMs: number | null) => BUSY_RETRY.retryDelay(0, new BusyError('revision_busy', retryAfterMs))
    expect([wait(5_000), wait(30_000), wait(200), wait(null)]).toEqual([5_000, 10_000, 1_000, 1_000])
    vi.spyOn(Math, 'random').mockReturnValue(0.999)
    expect(wait(5_000)).toBe(5_499)
  })
})

describe.each(HOOKS)('%s', (_name, fn, hook) => {
  it('is asked again after a busy answer, once its Retry-After has passed', async () => {
    api[fn].mockRejectedValueOnce(new BusyError('change_list_busy', 2_000)).mockResolvedValue({ commits: [] })
    const { result } = render(hook)
    await elapse(1_999)
    expect(api[fn]).toHaveBeenCalledTimes(1)
    await elapse(1)
    expect(api[fn]).toHaveBeenCalledTimes(2)
    await settle()
    expect(result.current.data).toBeDefined()
  })

  it('is not asked again after any other failure', async () => {
    api[fn].mockRejectedValue(Object.assign(new Error('internal error'), { status: 500 }))
    const { result } = render(hook)
    await elapse(30_000)
    expect(api[fn]).toHaveBeenCalledTimes(1)
    expect(result.current.isError).toBe(true)
  })
})

describe('a server that stays busy', () => {
  it('is asked three more times, then the read fails', async () => {
    api.getChangeSummary.mockRejectedValue(new BusyError('change_list_busy', 5_000))
    const { result } = render(() => useChangeSummary('ws1', 'g1', window_))
    await elapse(5_000 * 3)
    expect(api.getChangeSummary).toHaveBeenCalledTimes(4)
    await settle()
    expect(result.current.isError).toBe(true)
    await elapse(60_000)
    expect(api.getChangeSummary).toHaveBeenCalledTimes(4)
  })
})
