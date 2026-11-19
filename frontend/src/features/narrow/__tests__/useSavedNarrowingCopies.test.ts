/**
 * useSavedNarrowingCopies — its saver keeps what a saved narrowing showed: the entities and
 * flows files the server writes, gzipped in IndexedDB, downloaded again without asking; none
 * past the row cap; and a removed one goes.
 */
import 'fake-indexeddb/auto'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchWithTimeout = vi.hoisted(() => vi.fn())
const triggerBrowserDownload = vi.hoisted(() => vi.fn())
const followMemberSet = vi.hoisted(() => vi.fn())
vi.mock('@/services/fetchWithTimeout', () => ({ fetchWithTimeout }))
vi.mock('@/services/importExportApiService', () => ({ triggerBrowserDownload }))
vi.mock('@/services/memberSetExport', () => ({ followMemberSet }))

import { useSavedNarrowingCopies } from '../useSavedNarrowingCopies'

const provider = { memberSetDownloadUrl: (set: string, token: string, _f: string, part: string) => `/dl/${set}/${part}?t=${token}` } as never
const spec = { v: 1, seeds: { urns: ['a'] }, within: 'view', expand: { children: 0, upstream: 0, downstream: 0, partnerChildren: 0 } } as never
let n = 0

describe('useSavedNarrowingCopies', () => {
  beforeEach(() => {
    fetchWithTimeout.mockReset(); triggerBrowserDownload.mockReset(); followMemberSet.mockReset()
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
  })

  it('keeps the entities and flows files, and downloads them again — after a reload too', async () => {
    const user = `u${++n}`
    followMemberSet.mockResolvedValue({ setId: 's1', downloadToken: 't1', counts: { total: 2 } })
    fetchWithTimeout.mockImplementation(async (url: string) => new Response(url.includes('edges') ? 'source,target\n' : 'urn,name\na,A\n'))
    const first = renderHook(() => useSavedNarrowingCopies(user))
    let kept = false
    await act(async () => { kept = await first.result.current.keep({ id: 'n1', viewId: 'v1', spec, fileBase: 'orders', provider }) })
    expect(kept).toBe(true)
    expect(followMemberSet.mock.calls[0][2]).toEqual({ spec, includeEdges: true })
    expect(fetchWithTimeout.mock.calls.map((c) => c[0])).toEqual(['/dl/s1/nodes?t=t1', '/dl/s1/edges?t=t1'])
    expect(first.result.current.ids.has('n1')).toBe(true)
    first.unmount()

    const again = renderHook(() => useSavedNarrowingCopies(user))
    await waitFor(() => expect(again.result.current.ids.has('n1')).toBe(true))
    await act(async () => { expect(await again.result.current.download('n1')).toBe(true) })
    expect(triggerBrowserDownload.mock.calls.map((c) => c[1])).toEqual(['orders.csv', 'orders-flows.csv'])
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob
    expect(await blob.text()).toBe('urn,name\na,A\n')

    act(() => again.result.current.drop('n1'))
    await waitFor(() => expect(again.result.current.ids.has('n1')).toBe(false))
    await act(async () => { expect(await again.result.current.download('n1')).toBe(false) })
  })

  it('keeps none past what a browser keeps', async () => {
    followMemberSet.mockResolvedValue({ setId: 's1', downloadToken: 't1', counts: { total: 600_000 } })
    const { result } = renderHook(() => useSavedNarrowingCopies(`u${++n}`))
    await act(async () => { expect(await result.current.keep({ id: 'n2', viewId: 'v1', spec, fileBase: 'x', provider })).toBe(false) })
    expect(fetchWithTimeout).not.toHaveBeenCalled()
    expect(result.current.ids.size).toBe(0)
  })
})
