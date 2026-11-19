/**
 * useFeedLookahead: a list or subset view's layer read a page ahead of its reader.
 *
 * Pinned here: a column within two pages of the end of what it holds gets one more page, when
 * the browser is idle; one page at a time across the canvas, the column nearest its end
 * first; nothing while the tab is hidden; nothing for a layer with no more, whose last page
 * failed, or whose reader is far from its end; and past VITE_CANVAS_LOADED_SOFT_MAX, nothing.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCanvasStore, type TypeFeedState } from '@/store/canvas'

import { useFeedLookahead } from '../useFeedLookahead'

const feedOf = (layerId: string, over: Partial<NonNullable<TypeFeedState['search']>> = {}, hasMore = true): TypeFeedState => ({
  entityTypes: [], offset: 0, hasMore, total: 50_000,
  search: {
    layerId, cursor: 'c', sessionId: null, status: 'complete', countStatus: 'exact', stale: false, asOf: null,
    capped: false, delivered: 200, source: 'members', ...over,
  },
})
const seed = (feeds: Record<string, TypeFeedState>) => useCanvasStore.getState().seedPositions({}, feeds)
const idle = () => act(async () => { await vi.advanceTimersByTimeAsync(5) })
const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useFeedLookahead', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setHidden(false)
    useCanvasStore.getState().setGraph([], [])
  })
  afterEach(() => { vi.useRealTimers() })

  it('reads one more page for a column within two pages of its end, when idle', async () => {
    seed({ 'layer:up': feedOf('up') })
    const loadMoreFeeds = vi.fn(async () => {})
    const { result } = renderHook(() => useFeedLookahead({ enabled: true, loadMoreFeeds }))
    act(() => result.current.reportVisible('up', 180))
    expect(loadMoreFeeds).not.toHaveBeenCalled()
    await idle()
    expect(loadMoreFeeds).toHaveBeenCalledWith(['layer:up'])
    // A report from before that page landed is not read again.
    await idle()
    expect(loadMoreFeeds).toHaveBeenCalledTimes(1)
  })

  it('one page at a time across the canvas, the column nearest its end first', async () => {
    seed({ 'layer:up': feedOf('up'), 'layer:down': feedOf('down') })
    let finish = () => {}
    const loadMoreFeeds = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const { result } = renderHook(() => useFeedLookahead({ enabled: true, loadMoreFeeds }))
    act(() => { result.current.reportVisible('up', 900); result.current.reportVisible('down', 40) })
    await idle()
    expect(loadMoreFeeds.mock.calls).toEqual([[['layer:down']]])
    act(() => result.current.reportVisible('up', 800))
    await idle()
    expect(loadMoreFeeds).toHaveBeenCalledTimes(1)
    // The page lands: `down` moved on (and says where it stands next), `up` is next.
    act(() => { seed({ 'layer:down': feedOf('down', { delivered: 700 }) }); finish() })
    await idle()
    expect(loadMoreFeeds.mock.calls).toEqual([[['layer:down']], [['layer:up']]])
  })

  it('asks nothing far from the end, for a layer with no more, one that failed, or one still counting', async () => {
    seed({
      'layer:far': feedOf('far'),
      'layer:done': feedOf('done', {}, false),
      'layer:failed': feedOf('failed'),
      'layer:running': feedOf('running', { status: 'running', sessionId: 's' }),
    })
    useCanvasStore.getState().markFeedFailures({ 'layer:failed': { message: 'busy', status: 503 } })
    const loadMoreFeeds = vi.fn(async () => {})
    const { result } = renderHook(() => useFeedLookahead({ enabled: true, loadMoreFeeds }))
    act(() => {
      result.current.reportVisible('far', 1_001)
      result.current.reportVisible('done', 0)
      result.current.reportVisible('failed', 0)
      result.current.reportVisible('running', 0)
    })
    await idle()
    expect(loadMoreFeeds).not.toHaveBeenCalled()
  })

  it('waits while the tab is hidden, and while it is turned off or the column says nothing', async () => {
    seed({ 'layer:up': feedOf('up') })
    const loadMoreFeeds = vi.fn(async () => {})
    const { result, rerender } = renderHook((p: { enabled: boolean }) => useFeedLookahead({ enabled: p.enabled, loadMoreFeeds }), {
      initialProps: { enabled: true },
    })
    setHidden(true)
    act(() => result.current.reportVisible('up', 10))
    await idle()
    expect(loadMoreFeeds).not.toHaveBeenCalled()
    act(() => setHidden(false))
    await idle()
    expect(loadMoreFeeds).toHaveBeenCalledTimes(1)

    loadMoreFeeds.mockClear()
    rerender({ enabled: false })
    seed({ 'layer:up': feedOf('up', { delivered: 700 }) })
    act(() => result.current.reportVisible('up', 10))
    await idle()
    expect(loadMoreFeeds).not.toHaveBeenCalled()
    rerender({ enabled: true })
    act(() => result.current.reportVisible('up', null))
    await idle()
    expect(loadMoreFeeds).not.toHaveBeenCalled()
  })

  it('past the soft ceiling, nothing is read ahead — and it says so', async () => {
    vi.stubEnv('VITE_CANVAS_LOADED_SOFT_MAX', '2')
    vi.resetModules()
    const { useFeedLookahead: capped } = await import('../useFeedLookahead')
    const { useCanvasStore: store } = await import('@/store/canvas')
    store.getState().seedPositions({}, { 'layer:up': feedOf('up') })
    const toNode = (id: string) => ({ id, type: 'generic', position: { x: 0, y: 0 }, data: { urn: id, label: id, type: 't' } })
    store.getState().addGraph([toNode('a'), toNode('b')] as never, [])
    const loadMoreFeeds = vi.fn(async () => {})
    const { result } = renderHook(() => capped({ enabled: true, loadMoreFeeds }))
    expect(result.current.softMaxReached).toBe(true)
    act(() => result.current.reportVisible('up', 0))
    await idle()
    expect(loadMoreFeeds).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })
})
