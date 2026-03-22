/**
 * ExplorerEmptyState -- Shown when the Explorer has no views to display,
 * either because a search/filter returned nothing or the user has no views yet.
 */

import { Link } from 'react-router-dom'
import { Compass, SearchX, FilterX, Sparkles, LayoutGrid } from 'lucide-react'
import { cn } from '@/lib/utils'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ExplorerEmptyStateProps {
  type: 'no-results' | 'no-views'
  searchTerm?: string
  hasFilters?: boolean
  activeCategory?: string | null
  onClearFilters?: () => void
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const CATEGORY_HINTS: Record<string, string> = {
  'my-views': "You haven't created any views yet. Save a view from a workspace to see it here.",
  'my-favourites': "You haven't favourited any views yet. Click the heart on any view to add it to your favourites.",
  'recently-added': 'No views have been created in the last 7 days.',
  'shared-with-me': 'No views have been shared at workspace or enterprise level.',
  'needs-attention': 'All views are healthy — no broken or stale views found.',
}

export function ExplorerEmptyState({
  type,
  searchTerm,
  hasFilters,
  activeCategory,
  onClearFilters,
}: ExplorerEmptyStateProps) {
  /* ── No views exist yet ── */
  if (type === 'no-views') {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        {/* Large icon with subtle glow */}
        <div className="relative mb-8">
          <div className="absolute inset-0 rounded-full bg-accent-lineage/10 blur-2xl" />
          <div className="relative w-20 h-20 rounded-2xl border border-glass-border glass-panel flex items-center justify-center">
            <Compass
              className="h-10 w-10 text-accent-lineage"
              strokeWidth={1.2}
            />
          </div>
        </div>

        {/* Gradient heading */}
        <h3 className="text-2xl font-bold mb-3 bg-gradient-to-r from-accent-lineage to-violet-600 bg-clip-text text-transparent">
          No views yet
        </h3>

        <p className="text-ink-muted text-sm max-w-md mb-8 leading-relaxed">
          Create your first view from a workspace to start exploring your
          data graph. Views let you save, share, and collaborate on custom
          perspectives.
        </p>

        {/* CTA button */}
        <Link
          to="/admin/registry"
          className={cn(
            'inline-flex items-center gap-2 rounded-xl px-6 py-3',
            'bg-gradient-to-r from-accent-lineage to-violet-600 text-white text-sm font-semibold',
            'shadow-lg shadow-accent-lineage/25',
            'hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200',
          )}
        >
          <Sparkles className="h-4 w-4" />
          Go to Workspace Management
        </Link>
      </div>
    )
  }

  /* ── No search/filter results ── */
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      {/* Icon */}
      <div className="relative mb-8">
        <div className="w-16 h-16 rounded-2xl border border-glass-border glass-panel flex items-center justify-center">
          <SearchX
            className="h-8 w-8 text-ink-muted"
            strokeWidth={1.2}
          />
        </div>
      </div>

      <h3 className="text-xl font-bold text-ink mb-3">
        No views match your search
      </h3>

      <div className="flex flex-col items-center gap-4 max-w-md">
        {/* Search term highlight */}
        {searchTerm && (
          <p className="text-sm text-ink-muted leading-relaxed">
            No views match{' '}
            <span className="font-bold text-ink">
              &ldquo;{searchTerm}&rdquo;
            </span>
            . Try a different keyword or adjust your filters.
          </p>
        )}

        {/* Category-specific hint */}
        {activeCategory && CATEGORY_HINTS[activeCategory] && (
          <p className="text-sm text-ink-muted leading-relaxed">
            {CATEGORY_HINTS[activeCategory]}
          </p>
        )}

        {/* Contextual suggestions */}
        {!activeCategory && hasFilters && (
          <div className="flex items-center gap-2.5 text-sm text-ink-muted">
            <FilterX className="h-4 w-4 shrink-0" />
            <span>Try removing some filters to broaden results</span>
          </div>
        )}

        {!searchTerm && !hasFilters && !activeCategory && (
          <div className="flex items-center gap-2.5 text-sm text-ink-muted">
            <LayoutGrid className="h-4 w-4 shrink-0" />
            <span>Browse all available views to find what you need</span>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-3 mt-4">
          {hasFilters && onClearFilters && (
            <button
              onClick={onClearFilters}
              className={cn(
                'glass-panel inline-flex items-center gap-2 border border-glass-border rounded-xl px-5 py-2.5',
                'text-sm text-ink-muted font-medium',
                'hover:text-ink hover:border-glass-border/80 transition-all duration-200',
              )}
            >
              <FilterX className="h-3.5 w-3.5" />
              Clear all filters
            </button>
          )}

          <button
            onClick={onClearFilters}
            className={cn(
              'inline-flex items-center gap-2 rounded-xl px-6 py-3',
              'bg-gradient-to-r from-accent-lineage to-violet-600 text-white text-sm font-semibold',
              'shadow-lg shadow-accent-lineage/25',
              'hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200',
            )}
          >
            <LayoutGrid className="h-4 w-4" />
            Show all views
          </button>
        </div>
      </div>
    </div>
  )
}
