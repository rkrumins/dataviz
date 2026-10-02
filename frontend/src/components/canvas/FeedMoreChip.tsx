/**
 * FeedMoreChip — continues the Hierarchy and Graph views' entity feeds.
 *
 * Those views load their roots (and orphans of child types) a page at a time.
 * They used to stop at the first page with nothing to say so; the rest of the
 * graph was unreachable. They have no scrolling list whose end could trigger
 * the next page, so continuing is a click — and the chip says what is loaded,
 * when a page is in flight, and when one failed (retry, never "looks done").
 *
 * It renders nothing once every feed is exhausted.
 */
import * as LucideIcons from 'lucide-react'
import { useCanvasStore } from '@/store/canvas'

/** The feeds the Hierarchy/Graph loader keeps (see useGraphHydration). */
const HIERARCHY_FEED_KEYS = ['__roots__', '__orphans__'] as const

export function FeedMoreChip({
  loadingNodes,
  failedNodes,
  onLoadMore,
  bottomClass = 'bottom-4',
}: {
  /** The calling hook instance's in-flight keys (`TYPE:<feedKey>`). */
  loadingNodes: Set<string>
  /** The calling hook instance's failed keys (`TYPE:<feedKey>`). */
  failedNodes: Set<string>
  onLoadMore: (feedKeys: string[]) => void
  /** Vertical placement — clear of whatever the host canvas already has at its foot. */
  bottomClass?: string
}) {
  const typeFeeds = useCanvasStore(s => s.typeFeeds)
  const open = HIERARCHY_FEED_KEYS.filter(k => typeFeeds[k]?.hasMore)
  if (open.length === 0) return null

  const loaded = HIERARCHY_FEED_KEYS.reduce((n, k) => n + (typeFeeds[k]?.offset ?? 0), 0)
  const loading = open.some(k => loadingNodes.has(`TYPE:${k}`))
  const failed = !loading && open.some(k => failedNodes.has(`TYPE:${k}`))

  return (
    <div className={`absolute ${bottomClass} left-1/2 -translate-x-1/2 z-30 pointer-events-none`} data-canvas-interactive>
      <button
        type="button"
        onClick={() => onLoadMore([...open])}
        disabled={loading}
        className="pointer-events-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-glass-border bg-canvas-elevated shadow-md text-[11px] font-medium text-ink-muted hover:text-ink disabled:cursor-wait focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage"
      >
        {loading ? (
          <>
            <LucideIcons.Loader2 className="w-3 h-3 animate-spin" />
            Loading more…
          </>
        ) : failed ? (
          <>
            <LucideIcons.RotateCw className="w-3 h-3" />
            Couldn't load more · Retry
          </>
        ) : (
          <>
            <LucideIcons.ListPlus className="w-3 h-3" />
            <span className="tabular-nums">{loaded.toLocaleString()}</span> loaded · Load more
          </>
        )}
      </button>
    </div>
  )
}
