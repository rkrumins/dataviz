/**
 * HeaderSearch / HeaderSearchResults — the Context View header's quick
 * search, extracted verbatim from ContextViewHeader (same classes, copy,
 * and framer-motion animations).
 *
 * These are two separate layout slots in the header today, so they stay
 * two separate components to preserve that DOM placement:
 *   - `HeaderSearch`        — the field + helper/escalation row, which
 *     lives in the header grid's center cell.
 *   - `HeaderSearchResults` — the results-chips row + no-match escalation
 *     card, which lives BELOW the grid at full header width.
 */

import { useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import type { HierarchyNode } from '../types'

export interface HeaderSearchProps {
  searchQuery: string
  onSearchChange: (q: string) => void
  onOpenAdvancedSearch?: (seedQuery?: string) => void
}

export function HeaderSearch({ searchQuery, onSearchChange, onOpenAdvancedSearch }: HeaderSearchProps) {
  const searchInputRef = useRef<HTMLInputElement>(null)

  return (
    <div className="justify-self-center w-full max-w-md">
      <div className="relative group">
        {/* Accent halo on focus — soft glow behind the input that
            lifts it off the header gradient. Pure decoration; sits
            behind the input via negative inset. */}
        <div
          aria-hidden
          className={cn(
            "absolute -inset-px rounded-[14px] pointer-events-none",
            "bg-gradient-to-r from-accent-lineage/0 via-accent-lineage/0 to-purple-500/0",
            "group-focus-within:from-accent-lineage/20 group-focus-within:via-accent-lineage/10 group-focus-within:to-purple-500/15",
            "group-focus-within:blur-[8px]",
            "transition-all duration-300",
          )}
        />
        <LucideIcons.Search
          className={cn(
            "absolute left-3.5 top-1/2 -translate-y-1/2 w-[15px] h-[15px] pointer-events-none",
            "text-ink-muted/55 group-focus-within:text-accent-lineage",
            "group-hover:text-ink-muted/80",
            "transition-colors duration-200",
          )}
          strokeWidth={2.2}
        />
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Search visible entities…"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          aria-label="Search visible entities by name or type"
          className={cn(
            "relative w-full pl-10 pr-32 py-2.5 rounded-[13px]",
            "text-[13.5px] text-ink placeholder:text-ink-muted/45",
            // Layered fill: subtle gradient + glass border so the
            // field reads like a deliberate component, not a
            // default text input.
            "bg-gradient-to-b from-black/[0.03] to-black/[0.05]",
            "dark:from-white/[0.04] dark:to-white/[0.025]",
            "border border-black/[0.08] dark:border-white/[0.08]",
            "shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
            // Hover: brighten the inner ring.
            "hover:border-black/[0.14] dark:hover:border-white/[0.14]",
            // Focus: accent ring + lift shadow. Not a system blue
            // outline.
            "focus:outline-none",
            "focus:border-accent-lineage/55 focus:ring-2 focus:ring-accent-lineage/20",
            "focus:shadow-[0_4px_18px_-6px_rgba(99,102,241,0.35)]",
            "focus:bg-gradient-to-b focus:from-black/[0.045] focus:to-black/[0.06]",
            "dark:focus:from-white/[0.06] dark:focus:to-white/[0.045]",
            "transition-all duration-200",
          )}
        />
        {/* Right-side affordance cluster.
            Idle: a sparkles button that opens Advanced Search
            (scans the entire graph at any depth) + a separator
            + a passive "Visible" scope label so the user
            understands the default quick-search scope.
            Typed: a clear (X) button on the left of the
            advanced trigger so the user can wipe and retry
            without losing the escalation affordance. */}
        <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {searchQuery && (
            <button
              onClick={() => onSearchChange('')}
              aria-label="Clear search"
              className={cn(
                "p-1 rounded-md transition-all",
                "text-ink-muted/70 hover:text-ink",
                "hover:bg-black/[0.06] dark:hover:bg-white/[0.08]",
              )}
            >
              <LucideIcons.X className="w-3.5 h-3.5" strokeWidth={2.4} />
            </button>
          )}
          {!searchQuery && (
            <span
              title="Quick search scans the entities currently visible on this canvas."
              className={cn(
                "hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md",
                "text-[10px] font-semibold uppercase tracking-wider",
                "text-ink-muted/70",
                "bg-gradient-to-b from-black/[0.04] to-black/[0.06]",
                "dark:from-white/[0.05] dark:to-white/[0.03]",
                "border border-black/[0.06] dark:border-white/[0.06]",
                "shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
              )}
            >
              <LucideIcons.Eye className="w-2.5 h-2.5" strokeWidth={2.4} />
              Visible
            </span>
          )}
          {onOpenAdvancedSearch && (
            <button
              onClick={() => onOpenAdvancedSearch(searchQuery.trim() || undefined)}
              aria-label={searchQuery.trim()
                ? `Search "${searchQuery.trim()}" across the entire graph with Advanced Search`
                : 'Open Advanced Search — scan the entire graph'}
              title={searchQuery.trim()
                ? `Search "${searchQuery.trim()}" across the entire graph`
                : 'Open Advanced Search · scan the entire graph at any depth'}
              className={cn(
                'inline-flex items-center justify-center w-7 h-7 rounded-lg',
                'transition-all duration-200',
                'text-accent-lineage',
                'bg-gradient-to-br from-accent-lineage/15 to-purple-500/10',
                'border border-accent-lineage/30',
                'hover:from-accent-lineage/25 hover:to-purple-500/20',
                'hover:border-accent-lineage/55 hover:shadow-md hover:shadow-accent-lineage/20',
                'active:scale-95',
              )}
            >
              <LucideIcons.Sparkles className="w-3.5 h-3.5" strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      {/* Inline helper / escalation row — always visible so users
          learn the boundary between quick and advanced search.
          Compresses to icon-only on narrower viewports via the
          hidden md:inline classes. When the user already typed
          something, the escalation link seeds the Advanced panel
          with that text so they don't retype. */}
      {onOpenAdvancedSearch && (
        <div className="mt-1.5 px-1 flex items-center justify-between gap-2 text-[10.5px] leading-none">
          <span className="text-ink-muted/65 truncate">
            <LucideIcons.Layers
              className="inline-block w-2.5 h-2.5 mr-1 -mt-0.5 opacity-70"
              strokeWidth={2.2}
            />
            <span className="hidden md:inline">Searching visible entities only. </span>
            <span className="md:hidden">Visible only. </span>
            <button
              onClick={() => onOpenAdvancedSearch(searchQuery.trim() || undefined)}
              className={cn(
                "font-semibold text-accent-lineage",
                "hover:text-accent-lineage hover:underline",
                "underline-offset-[3px] decoration-accent-lineage/40 hover:decoration-accent-lineage/80",
                "transition-colors",
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

export interface HeaderSearchResultsProps {
  searchQuery: string
  searchResults: HierarchyNode[]
  onSearchResultClick: (node: HierarchyNode) => void
  onOpenAdvancedSearch?: (seedQuery?: string) => void
}

export function HeaderSearchResults({
  searchQuery,
  searchResults,
  onSearchResultClick,
  onOpenAdvancedSearch,
}: HeaderSearchResultsProps) {
  return (
    <AnimatePresence>
      {searchQuery.trim().length > 0 && searchResults.length === 0 && (
        <motion.div
          key="no-results-escalation"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="mt-3"
        >
          <div className={cn(
            "flex items-center gap-3 px-3.5 py-2.5 rounded-xl",
            "border-l-4 border-l-accent-lineage border border-accent-lineage/40",
            "bg-accent-lineage/[0.10] dark:bg-accent-lineage/[0.12]",
            "shadow-[0_0_18px_-6px_rgba(99,102,241,0.35)]",
          )}>
            <div className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center bg-accent-lineage/20 border border-accent-lineage/40">
              <LucideIcons.SearchX className="w-4 h-4 text-accent-lineage" strokeWidth={2.4} />
            </div>
            <div className="flex-1 min-w-0 text-[12px] leading-snug">
              <div className="font-display font-semibold text-ink">
                No match in visible entities
              </div>
              <div className="text-ink-muted">
                &ldquo;{searchQuery}&rdquo; isn&rsquo;t on the canvas right now.
                Advanced Search scans the entire graph — across
                every depth, every entity type, every lineage path.
              </div>
            </div>
            {onOpenAdvancedSearch && (
              <button
                onClick={() => onOpenAdvancedSearch(searchQuery.trim() || undefined)}
                className={cn(
                  "shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg",
                  "bg-accent-lineage text-white text-[12px] font-semibold",
                  "shadow-lg shadow-accent-lineage/30",
                  "hover:bg-accent-lineage/90 hover:shadow-accent-lineage/40",
                  "transition-all active:scale-[0.98]",
                )}
              >
                <LucideIcons.Sparkles className="w-3.5 h-3.5" strokeWidth={2.4} />
                Advanced Search
                <LucideIcons.ArrowRight className="w-3 h-3" strokeWidth={2.4} />
              </button>
            )}
          </div>
        </motion.div>
      )}
      {searchResults.length > 0 && (
        <motion.div
          key="results-chips"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="mt-3 flex items-center gap-2 flex-wrap relative"
        >
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-amber-500/10 border border-amber-500/20">
            <LucideIcons.Search className="w-3.5 h-3.5 text-amber-500" />
            <span className="text-xs font-medium text-amber-600 dark:text-amber-300">
              {searchResults.length} in visible
            </span>
          </div>
          {searchResults.slice(0, 5).map((node, idx) => (
            <motion.button
              key={node.id}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: idx * 0.05 }}
              onClick={() => onSearchResultClick(node)}
              className="px-3 py-1.5 rounded-xl bg-black/[0.04] dark:bg-white/[0.04] border border-black/[0.10] dark:border-white/[0.08] text-ink text-xs font-medium hover:bg-accent-lineage/15 hover:border-accent-lineage/40 hover:text-accent-lineage transition-all duration-200 hover:shadow-md hover:shadow-black/5 dark:hover:shadow-lg dark:hover:shadow-accent-lineage/10"
            >
              {node.name}
            </motion.button>
          ))}
          {searchResults.length > 5 && (
            <span className="px-2 py-1 text-xs text-ink-muted/60">+{searchResults.length - 5} more</span>
          )}
          {/* Tail escalation: "Search the entire graph for X" link.
              Keeps quick search as the default but makes the
              Advanced upgrade discoverable inline. Seeds the
              Advanced panel with the current query so the user
              doesn't retype. */}
          {onOpenAdvancedSearch && (
            <button
              onClick={() => onOpenAdvancedSearch(searchQuery.trim() || undefined)}
              title="Open Advanced Search — scans the full graph at any depth"
              className={cn(
                "ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl",
                "text-xs font-medium",
                "bg-accent-lineage/10 text-accent-lineage",
                "border border-accent-lineage/30 hover:border-accent-lineage/60",
                "hover:bg-accent-lineage/20 transition-all",
              )}
            >
              <LucideIcons.Sparkles className="w-3 h-3" strokeWidth={2.4} />
              Search entire graph
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
