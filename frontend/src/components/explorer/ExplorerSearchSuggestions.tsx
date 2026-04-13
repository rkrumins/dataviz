/**
 * ExplorerSearchSuggestions — panel that surfaces recent searches and
 * example queries when the search input is focused and empty.
 *
 * Recent searches live in ``localStorage`` so they survive page
 * reloads without adding backend state. Example queries are static
 * tips that hint at the search surface (workspace / tag / owner).
 */
import { Clock, History, Sparkles, X } from 'lucide-react'
import { cn } from '@/lib/utils'

const EXAMPLES: { label: string; query: string; hint: string }[] = [
  { label: 'Your favourite views', query: 'is:favourite', hint: 'or pick the Favorites pill' },
  { label: 'Views that need attention', query: 'is:stale', hint: 'broken or outdated' },
  { label: 'Search by workspace', query: 'production', hint: 'matches workspace names' },
  { label: 'Search by tag', query: 'finance', hint: 'matches tagged views' },
]

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
  const hasRecents = recentSearches.length > 0
  return (
    <div
      className={cn(
        'absolute left-0 right-0 top-full z-30 mt-2',
        'rounded-xl border border-glass-border bg-canvas-elevated shadow-xl',
        'p-2 text-xs',
      )}
      role="listbox"
    >
      {hasRecents && (
        <div className="mb-1">
          <div className="flex items-center justify-between px-2 py-1">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-ink-muted">
              <History className="h-3 w-3" />
              Recent
            </div>
            <button
              type="button"
              onClick={onClearRecents}
              className="text-[10px] text-ink-muted hover:text-ink transition-colors"
              // Keep the search input focused — see onMouseDown note below.
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
                // Prevent the input from blurring before we can apply the
                // pick. onMouseDown fires before the blur and lets the
                // click handler still fire.
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
      )}

      <div className={cn(hasRecents && 'border-t border-glass-border/50 pt-1')}>
        <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] uppercase tracking-wider font-bold text-ink-muted">
          <Sparkles className="h-3 w-3" />
          Try
        </div>
        {EXAMPLES.map(ex => (
          <button
            key={ex.query}
            type="button"
            onMouseDown={e => e.preventDefault()}
            onClick={() => onPick(ex.query)}
            className={cn(
              'w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left',
              'text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors',
            )}
          >
            <span className="flex-1 min-w-0 truncate font-medium">{ex.label}</span>
            <code className="shrink-0 rounded bg-black/[0.04] dark:bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-mono text-ink-muted">
              {ex.query}
            </code>
            <span className="hidden md:inline text-[10px] text-ink-muted/60 truncate max-w-[120px]">
              {ex.hint}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
