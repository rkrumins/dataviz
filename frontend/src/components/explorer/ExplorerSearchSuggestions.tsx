/**
 * ExplorerSearchSuggestions — recent-search panel that appears below
 * the search input when it's focused and empty.
 *
 * Recent searches live in ``localStorage`` (see ``useRecentSearches``)
 * so they survive reloads without server state. The panel silently
 * collapses when there are no recents — no value in surfacing empty
 * chrome.
 */
import { Clock, History, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ExplorerSearchSuggestionsProps {
  recentSearches: string[]
  onPick: (query: string) => void
  onClearRecents: () => void
  onRemoveRecent: (query: string) => void
}

export function ExplorerSearchSuggestions({
  recentSearches,
  onPick,
  onClearRecents,
  onRemoveRecent,
}: ExplorerSearchSuggestionsProps) {
  // Nothing to show yet — let the input stand alone rather than render
  // an empty frame. First real search seeds the list going forward.
  if (recentSearches.length === 0) return null

  return (
    <div
      className={cn(
        'absolute left-0 right-0 top-full z-30 mt-2',
        'rounded-xl border border-glass-border bg-canvas-elevated shadow-xl',
        'p-2 text-xs',
      )}
      role="listbox"
    >
      <div className="flex items-center justify-between px-2 py-1">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-ink-muted">
          <History className="h-3 w-3" />
          Recent searches
        </div>
        <button
          type="button"
          onClick={onClearRecents}
          className="text-[10px] text-ink-muted hover:text-ink transition-colors"
          // onMouseDown prevents the input from blurring before the
          // click handler has a chance to run.
          onMouseDown={e => e.preventDefault()}
        >
          Clear
        </button>
      </div>
      {recentSearches.map(q => (
        <div
          key={q}
          className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]"
        >
          <Clock className="h-3 w-3 text-ink-muted/70 shrink-0" />
          <button
            type="button"
            onMouseDown={e => e.preventDefault()}
            onClick={() => onPick(q)}
            className="flex-1 text-left truncate font-medium"
          >
            {q}
          </button>
          <button
            type="button"
            onMouseDown={e => e.preventDefault()}
            onClick={() => onRemoveRecent(q)}
            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-opacity"
            aria-label={`Remove ${q} from recent searches`}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
