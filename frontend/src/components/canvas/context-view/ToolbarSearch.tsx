/**
 * ToolbarSearch — the central, scope-aware search field for the canvas header.
 *
 * Strategic uplift: a single field is now the entry point to BOTH search depths.
 * An in-field scope control replaces the old standalone "Advanced Search" button:
 *
 *   · Visible      — live, client-side filter of the entities currently on the
 *                    canvas (drives the results chips rendered by the header).
 *   · Entire graph — hands off to the deep predicate search surface, seeded with
 *                    whatever the user has typed (`onOpenAdvancedSearch(seed)`).
 *
 * The field owns no results rendering — the header keeps the results / no-match
 * escalation rows below the bar so they can span its full width.
 */

import { useRef } from 'react'
import { Eye, Globe, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ToolbarSearchProps {
  searchQuery: string
  onSearchChange: (q: string) => void
  /** Opens the deep predicate search, optionally seeded with the typed text. */
  onOpenAdvancedSearch?: (seedQuery?: string) => void
}

export function ToolbarSearch({
  searchQuery,
  onSearchChange,
  onOpenAdvancedSearch,
}: ToolbarSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  const escalate = () => onOpenAdvancedSearch?.(searchQuery.trim() || undefined)

  return (
    <div className="justify-self-center w-full max-w-md">
      <div className="relative group">
        {/* Accent halo on focus */}
        <div
          aria-hidden
          className={cn(
            'absolute -inset-px rounded-[14px] pointer-events-none',
            'bg-gradient-to-r from-accent-lineage/0 via-accent-lineage/0 to-purple-500/0',
            'group-focus-within:from-accent-lineage/20 group-focus-within:via-accent-lineage/10 group-focus-within:to-purple-500/15',
            'group-focus-within:blur-[8px] transition-all duration-300',
          )}
        />
        <Search
          className={cn(
            'absolute left-3.5 top-1/2 -translate-y-1/2 w-[15px] h-[15px] pointer-events-none',
            'text-ink-muted/55 group-focus-within:text-accent-lineage group-hover:text-ink-muted/80',
            'transition-colors duration-200',
          )}
          strokeWidth={2.2}
        />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search visible entities…"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={(e) => {
            // Power-user accelerator: ⌘/Ctrl+Enter escalates to the full graph.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              escalate()
            }
          }}
          aria-label="Search visible entities by name or type"
          className={cn(
            'relative w-full pl-10 pr-[8.5rem] py-2.5 rounded-[13px]',
            'text-[13.5px] text-ink placeholder:text-ink-muted/45',
            'bg-gradient-to-b from-black/[0.03] to-black/[0.05]',
            'dark:from-white/[0.04] dark:to-white/[0.025]',
            'border border-black/[0.08] dark:border-white/[0.08]',
            'shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]',
            'hover:border-black/[0.14] dark:hover:border-white/[0.14]',
            'focus:outline-none focus:border-accent-lineage/55 focus:ring-2 focus:ring-accent-lineage/20',
            'focus:shadow-[0_4px_18px_-6px_rgba(99,102,241,0.35)]',
            'focus:bg-gradient-to-b focus:from-black/[0.045] focus:to-black/[0.06]',
            'dark:focus:from-white/[0.06] dark:focus:to-white/[0.045]',
            'transition-all duration-200',
          )}
        />

        {/* Right cluster: clear + scope control */}
        <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {searchQuery && (
            <button
              onClick={() => { onSearchChange(''); inputRef.current?.focus() }}
              aria-label="Clear search"
              className={cn(
                'p-1 rounded-md transition-all text-ink-muted/70 hover:text-ink',
                'hover:bg-black/[0.06] dark:hover:bg-white/[0.08]',
              )}
            >
              <X className="w-3.5 h-3.5" strokeWidth={2.4} />
            </button>
          )}

          {/* Scope segmented control. Visible is the live default; Entire graph
              hands off to the deep search surface seeded with the typed text. */}
          {onOpenAdvancedSearch && (
            <div
              role="group"
              aria-label="Search scope"
              className={cn(
                'flex items-center gap-0.5 p-0.5 rounded-lg',
                'bg-gradient-to-b from-black/[0.04] to-black/[0.06]',
                'dark:from-white/[0.05] dark:to-white/[0.03]',
                'border border-black/[0.06] dark:border-white/[0.06]',
                'shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]',
              )}
            >
              <span
                title="Searching the entities currently visible on this canvas"
                className={cn(
                  'inline-flex items-center gap-1 px-1.5 py-1 rounded-md',
                  'text-[10px] font-semibold uppercase tracking-wider',
                  'bg-accent-lineage/15 text-accent-lineage',
                  'shadow-sm shadow-accent-lineage/10',
                )}
              >
                <Eye className="w-2.5 h-2.5" strokeWidth={2.6} />
                <span className="hidden sm:inline">Visible</span>
              </span>
              <button
                onClick={escalate}
                aria-label={searchQuery.trim()
                  ? `Search "${searchQuery.trim()}" across the entire graph`
                  : 'Search the entire graph'}
                title={searchQuery.trim()
                  ? `Search "${searchQuery.trim()}" across the entire graph`
                  : 'Search the entire graph at any depth'}
                className={cn(
                  'inline-flex items-center gap-1 px-1.5 py-1 rounded-md',
                  'text-[10px] font-semibold uppercase tracking-wider',
                  'text-ink-muted/70 hover:text-accent-lineage',
                  'hover:bg-accent-lineage/10 transition-all active:scale-95',
                )}
              >
                <Globe className="w-2.5 h-2.5" strokeWidth={2.6} />
                <span className="hidden sm:inline">Graph</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Inline scope hint + escalation link — teaches the visible/graph boundary. */}
      {onOpenAdvancedSearch && (
        <div className="mt-1.5 px-1 flex items-center justify-between gap-2 text-[10.5px] leading-none">
          <span className="text-ink-muted/65 truncate">
            <Eye className="inline-block w-2.5 h-2.5 mr-1 -mt-0.5 opacity-70" strokeWidth={2.2} />
            <span className="hidden md:inline">Searching visible entities only. </span>
            <span className="md:hidden">Visible only. </span>
            <button
              onClick={escalate}
              className={cn(
                'font-semibold text-accent-lineage hover:text-accent-lineage hover:underline',
                'underline-offset-[3px] decoration-accent-lineage/40 hover:decoration-accent-lineage/80 transition-colors',
              )}
            >
              {searchQuery.trim()
                ? `Search "${searchQuery.trim()}" across entire graph →`
                : 'Search the entire graph →'}
            </button>
          </span>
        </div>
      )}
    </div>
  )
}
