/**
 * useAllValues — every value a property holds, asked once its name has stood still a moment, again
 * as the draft changes (the last values kept meanwhile), and again on a retry after a failure.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useBranchStore } from '@/store/branchStore'

const follow = vi.hoisted(() => vi.fn())
vi.mock('@/services/propertyCatalog', () => ({ followCatalog: follow }))
let provider: RemoteGraphProvider
vi.mock('@/providers/GraphProviderContext', () => ({ useGraphProvider: () => provider }))

import { useAllValues } from '../useAllValues'

const FINANCE = { value: 'Finance', kind: 'String', count: 200 }
const answer = (key: string, values = [FINANCE]) => ({ properties: [{ key, values }] })

beforeEach(() => {
  follow.mockReset()
  provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
})
afterEach(() => { vi.useRealTimers() })

describe('useAllValues', () => {
  it('asks once the name has stood still for a moment', async () => {
    vi.useFakeTimers()
    follow.mockImplementation(async (_p: unknown, _v: string, opts: { valuesFor: string }) => answer(opts.valuesFor))
    const { result, rerender } = renderHook(({ k }) => useAllValues('v1', k), { initialProps: { k: 'd' } })
    expect(follow).toHaveBeenCalledTimes(1)             // the name it opens with: at once
    for (const k of ['de', 'dep', 'dept']) rerender({ k })
    expect(result.current.loading).toBe(true)
    await act(async () => { vi.advanceTimersByTime(299) })
    expect(follow).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(follow).toHaveBeenCalledTimes(2)
    expect(follow.mock.calls[1][2]).toMatchObject({ valuesFor: 'dept' })
    await act(async () => { await Promise.resolve() })
    expect(result.current).toMatchObject({ values: [FINANCE], loading: false, error: null })
  })

  it('reads them again as the draft changes, keeping the last ones meanwhile', async () => {
    follow.mockResolvedValueOnce(answer('dept')).mockImplementationOnce(() => new Promise(() => {}))
    const { result } = renderHook(() => useAllValues('v1', 'dept'))
    await waitFor(() => expect(result.current.values).toEqual([FINANCE]))
    act(() => { useBranchStore.getState().bumpDraftEpoch() })
    await waitFor(() => expect(follow).toHaveBeenCalledTimes(2))
    expect(result.current).toMatchObject({ values: [FINANCE], loading: true })
  })

  it('says why a read failed, and reads again on retry', async () => {
    follow.mockRejectedValueOnce(new Error('timed out')).mockResolvedValueOnce(answer('dept'))
    const { result } = renderHook(() => useAllValues('v1', 'dept'))
    await waitFor(() => expect(result.current.error).toBe('timed out'))
    expect(result.current.values).toBeNull()
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.values).toEqual([FINANCE]))
    expect(result.current.error).toBeNull()
    expect(follow).toHaveBeenCalledTimes(2)
  })

  it("reads a relationship property's values from the relationships' catalog", async () => {
    follow.mockResolvedValueOnce(answer('weight'))
    const { result } = renderHook(() => useAllValues('v1', 'weight', true, 'relationships'))
    await waitFor(() => expect(result.current.values).toEqual([FINANCE]))
    expect(follow.mock.calls[0][2]).toMatchObject({ subject: 'relationships', valuesFor: 'weight' })
  })
})
