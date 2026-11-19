/**
 * Read a list or subset view's layer a little ahead of its reader.
 *
 * Paging stays the reader's: a column's foot row (LoadMoreItem) loads the next page as it
 * scrolls into view. On its own that makes a reader wait at every page, so each column also
 * reports how many of its rows lie below what it shows (LayerColumn `onVisibleRows`); while
 * that is within FEED_LOOKAHEAD_PAGES pages, one more page is asked for — when the browser is
 * idle, one page at a time across the whole canvas, nothing while the tab is out of sight, and
 * never for a layer whose last page failed (it waits for its Retry) or that has no more.
 *
 * `VITE_CANVAS_LOADED_SOFT_MAX` (0, the default: off): once the canvas holds more rows than
 * that, nothing is read ahead, and a column loads on only as it is scrolled to its end.
 */
import { useEffect, useState } from 'react'

import { FEED_PAGE_ROWS, subsetFeedKey, useCanvasStore } from '@/store/canvas'

/** How far ahead of a reader a layer is read, in pages. */
export const FEED_LOOKAHEAD_PAGES = 2

/** Rows the canvas holds past which nothing is read ahead (0: no such limit). */
export const CANVAS_LOADED_SOFT_MAX = Math.max(0, Number(import.meta.env.VITE_CANVAS_LOADED_SOFT_MAX ?? 0) || 0)

type LoadMoreFeeds = (feedKeys: string[]) => Promise<void>

export interface FeedLookahead {
  /** For each LayerColumn's `onVisibleRows`: rows below what it shows, or null when it reads
   *  nothing ahead (folded, filtered, tracing, off screen). Stable. */
  reportVisible: (layerId: string, rowsBelow: number | null) => void
  /** The canvas holds more rows than VITE_CANVAS_LOADED_SOFT_MAX: say so, and page only on scroll. */
  softMaxReached: boolean
}

const whenIdle = (fn: () => void): (() => void) => {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(fn, { timeout: 1000 })
    return () => window.cancelIdleCallback(handle)
  }
  const timer = window.setTimeout(fn, 1)
  return () => window.clearTimeout(timer)
}

/** One per canvas: where each column stands, and the one page it reads ahead at a time. */
class Lookahead {
  private readonly below = new Map<string, { rows: number; delivered: number }>()
  private inFlight = false
  private cancelIdle: (() => void) | null = null
  private onShow: (() => void) | null = null
  private enabled = false
  private loadMore: LoadMoreFeeds | null = null
  private softMax = 0
  private stopped = false

  configure(enabled: boolean, loadMore: LoadMoreFeeds, softMax: number) {
    this.enabled = enabled
    this.loadMore = loadMore
    this.softMax = softMax
    this.stopped = false
    if (enabled) this.schedule()
  }

  report = (layerId: string, rowsBelow: number | null) => {
    if (rowsBelow === null) { this.below.delete(layerId); return }
    // Where its feed stood when it said so: a report from before a page landed is stale.
    const delivered = useCanvasStore.getState().typeFeeds[subsetFeedKey(layerId)]?.search?.delivered ?? 0
    this.below.set(layerId, { rows: rowsBelow, delivered })
    this.schedule()
  }

  stop() {
    this.stopped = true
    this.cancelIdle?.()
    this.cancelIdle = null
    if (this.onShow) document.removeEventListener('visibilitychange', this.onShow)
    this.onShow = null
  }

  private schedule() {
    if (this.stopped || !this.enabled || this.inFlight || this.cancelIdle || this.onShow) return
    this.cancelIdle = whenIdle(() => { this.cancelIdle = null; this.check() })
  }

  private check() {
    if (this.stopped || !this.enabled || this.inFlight || !this.loadMore) return
    if (document.visibilityState === 'hidden') {
      // Out of sight: nothing until it is seen again.
      this.onShow = () => {
        if (document.visibilityState !== 'visible') return
        document.removeEventListener('visibilitychange', this.onShow!)
        this.onShow = null
        this.schedule()
      }
      document.addEventListener('visibilitychange', this.onShow)
      return
    }
    const store = useCanvasStore.getState()
    if (this.softMax > 0 && store.nodes.length >= this.softMax) return
    // The column nearest the end of what it holds goes first.
    let next: { layerId: string; rows: number } | null = null
    this.below.forEach((at, layerId) => {
      const key = subsetFeedKey(layerId)
      const feed = store.typeFeeds[key]
      if (!feed?.search || !feed.hasMore || feed.search.status === 'running' || store.feedFailures[key]) return
      if (feed.search.delivered !== at.delivered) return   // it hasn't said where it stands since its last page
      if (at.rows > FEED_LOOKAHEAD_PAGES * FEED_PAGE_ROWS) return
      if (!next || at.rows < next.rows) next = { layerId, rows: at.rows }
    })
    if (!next) return
    const { layerId } = next
    const key = subsetFeedKey(layerId)
    // Read again only once the column says where it stands after this page: a page whose rows
    // it doesn't show (inside a container it keeps closed) never drains the layer unattended.
    this.below.delete(layerId)
    this.inFlight = true
    void this.loadMore([key]).catch(() => {}).finally(() => {
      this.inFlight = false
      this.schedule()
    })
  }
}

export function useFeedLookahead({ enabled, loadMoreFeeds }: {
  /** A list or subset view, not narrowed, filtered or tracing: what the canvas reads ahead in. */
  enabled: boolean
  /** useGraphHydration's. */
  loadMoreFeeds: LoadMoreFeeds
}): FeedLookahead {
  const [lookahead] = useState(() => new Lookahead())
  useEffect(() => { lookahead.configure(enabled, loadMoreFeeds, CANVAS_LOADED_SOFT_MAX) }, [lookahead, enabled, loadMoreFeeds])
  useEffect(() => () => lookahead.stop(), [lookahead])
  const softMaxReached = useCanvasStore((s) => CANVAS_LOADED_SOFT_MAX > 0 && s.nodes.length >= CANVAS_LOADED_SOFT_MAX)
  return { reportVisible: lookahead.report, softMaxReached }
}
