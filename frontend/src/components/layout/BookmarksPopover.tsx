/**
 * FavoritesPopover — header popover showing favorited and recent views
 * for quick cross-workspace access.
 *
 * Exported as BookmarksPopover for backward compatibility with TopBar import.
 */
import { useState } from 'react'
import { Star, Search, X } from 'lucide-react'
import * as Popover from '@radix-ui/react-popover'
import { useNavigate } from 'react-router-dom'
import { useWorkspaceContext } from '@/hooks/useWorkspaceContext'
import { DynamicIcon, layoutTypeIcon, viewTypeColor } from '@/lib/viewUtils'
import { workspaceColor } from '@/lib/workspaceColor'
import { timeAgo } from '@/lib/timeAgo'
import { cn } from '@/lib/utils'
import type { View } from '@/services/viewApiService'
import type { RecentViewEntry } from '@/hooks/useRecentViews'

export function BookmarksPopover() {
  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const navigate = useNavigate()

  const {
    bookmarks,
    bookmarkedIds,
    recentViews,
    isLoadingBookmarks,
    openView,
    toggleBookmark,
  } = useWorkspaceContext()

  // Filter favorites by search
  const filteredFavorites = search
    ? bookmarks.filter(
        (b) =>
          b.name.toLowerCase().includes(search.toLowerCase()) ||
          (b.workspaceName ?? '').toLowerCase().includes(search.toLowerCase())
      )
    : bookmarks

  // Recent views that are NOT already favorited
  const recentNonFavorited = recentViews.filter(
    (r) => !bookmarkedIds.has(r.viewId)
  )

  const handleOpenView = (viewId: string, wsId?: string, dsId?: string) => {
    openView(viewId, wsId, dsId)
    setIsOpen(false)
    setSearch('')
  }

  const handleViewAll = () => {
    navigate('/explorer?favourites=true')
    setIsOpen(false)
    setSearch('')
  }

  const totalCount = bookmarks.length

  return (
    <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
      <Popover.Trigger asChild>
        <button
          className="btn btn-ghost p-2 rounded-lg relative"
          title={totalCount > 0 ? `${totalCount} favorite view${totalCount !== 1 ? 's' : ''}` : 'Favorites'}
        >
          <Star
            className={cn(
              'w-5 h-5 transition-colors',
              totalCount > 0
                ? 'text-accent-lineage fill-accent-lineage/20'
                : 'text-ink-secondary'
            )}
          />
          {totalCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-accent-lineage text-[9px] text-white flex items-center justify-center font-bold leading-none">
              {totalCount > 9 ? '9+' : totalCount}
            </span>
          )}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className="w-80 bg-canvas-elevated border border-glass-border rounded-xl shadow-2xl overflow-hidden z-50 animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
          sideOffset={8}
          align="end"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-glass-border">
            <span className="text-sm font-semibold text-ink">Favorites</span>
            <button
              onClick={handleViewAll}
              className="text-2xs text-ink-muted hover:text-accent-lineage transition-colors"
            >
              View all →
            </button>
          </div>

          {/* Search — only when > 5 favorites */}
          {bookmarks.length > 5 && (
            <div className="px-3 py-2 border-b border-glass-border bg-black/5 dark:bg-white/5">
              <div className="relative flex items-center">
                <Search className="absolute left-2.5 w-3.5 h-3.5 text-ink-muted" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search favorites..."
                  className="w-full bg-transparent pl-8 pr-3 py-1.5 text-sm text-ink focus:outline-none placeholder:text-ink-muted"
                />
              </div>
            </div>
          )}

          {/* Content */}
          <div className="max-h-[60vh] overflow-y-auto custom-scrollbar">
            {isLoadingBookmarks ? (
              <div className="px-4 py-6 text-center">
                <div className="w-5 h-5 border-2 border-accent-lineage/30 border-t-accent-lineage rounded-full animate-spin mx-auto" />
              </div>
            ) : totalCount === 0 && recentNonFavorited.length === 0 ? (
              /* Empty state */
              <div className="px-4 py-8 text-center">
                <Star className="w-8 h-8 text-ink-muted mx-auto mb-3" />
                <p className="text-sm font-medium text-ink">No favorites yet</p>
                <p className="text-xs text-ink-muted mt-1 leading-relaxed">
                  Favorite views in the Explorer to save them here for quick access.
                </p>
                <button
                  onClick={handleViewAll}
                  className="mt-3 text-xs font-medium text-accent-lineage hover:underline"
                >
                  Browse Explorer
                </button>
              </div>
            ) : (
              <>
                {/* Favorited views */}
                {filteredFavorites.length > 0 && (
                  <div className="py-1">
                    {filteredFavorites.map((view) => (
                      <FavoriteRow
                        key={view.id}
                        view={view}
                        onClick={() => handleOpenView(view.id, view.workspaceId, view.dataSourceId)}
                        onRemove={() => toggleBookmark(view.id, true)}
                      />
                    ))}
                  </div>
                )}

                {/* Recent (non-favorited) */}
                {recentNonFavorited.length > 0 && !search && (
                  <div className="border-t border-glass-border py-1">
                    <div className="px-4 py-1.5">
                      <span className="text-2xs font-medium text-ink-muted uppercase tracking-wider">
                        Recent
                      </span>
                    </div>
                    {recentNonFavorited.map((entry) => (
                      <RecentRow
                        key={entry.viewId}
                        entry={entry}
                        onClick={() =>
                          handleOpenView(entry.viewId, entry.workspaceId, entry.dataSourceId)
                        }
                      />
                    ))}
                  </div>
                )}

                {/* No search results */}
                {search && filteredFavorites.length === 0 && (
                  <div className="px-4 py-6 text-center text-xs text-ink-muted">
                    No favorites match &ldquo;{search}&rdquo;
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer hint */}
          {totalCount > 0 && (
            <div className="px-4 py-2.5 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02]">
              <p className="text-2xs text-ink-muted text-center">
                Favorite views in Explorer to save them here
              </p>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

// ── Favorite Row ──────────────────────────────────────────────────────

function FavoriteRow({
  view,
  onClick,
  onRemove,
}: {
  view: View
  onClick: () => void
  onRemove: () => void
}) {
  const iconName = layoutTypeIcon(view.viewType)
  const colorClass = viewTypeColor(view.viewType)
  const wsColors = view.workspaceId ? workspaceColor(view.workspaceId) : null

  return (
    <div
      className="group flex items-center gap-2.5 px-4 py-2 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
    >
      <DynamicIcon name={iconName} className={cn('w-4 h-4 shrink-0', colorClass)} />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-ink truncate leading-tight">{view.name}</p>
        {view.workspaceName && (
          <p className="text-2xs text-ink-muted truncate flex items-center gap-1 mt-0.5">
            {wsColors && (
              <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', wsColors.bg.replace('/15', ''))} />
            )}
            {view.workspaceName}
          </p>
        )}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-all"
        title="Remove from favorites"
      >
        <X className="w-3 h-3 text-ink-muted" />
      </button>
    </div>
  )
}

// ── Recent Row ────────────────────────────────────────────────────────

function RecentRow({
  entry,
  onClick,
}: {
  entry: RecentViewEntry
  onClick: () => void
}) {
  const iconName = layoutTypeIcon(entry.viewType)
  const colorClass = viewTypeColor(entry.viewType)

  return (
    <div
      className="group flex items-center gap-2.5 px-4 py-2 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
    >
      <DynamicIcon name={iconName} className={cn('w-4 h-4 shrink-0', colorClass)} />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-ink truncate leading-tight">{entry.viewName}</p>
        <p className="text-2xs text-ink-muted truncate flex items-center gap-1 mt-0.5">
          {timeAgo(entry.visitedAt)}
          {entry.workspaceName && (
            <>
              <span className="text-ink-muted/50">·</span>
              {entry.workspaceName}
            </>
          )}
        </p>
      </div>
    </div>
  )
}
