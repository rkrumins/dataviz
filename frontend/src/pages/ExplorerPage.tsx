/**
 * Explorer page: /explorer
 * Enterprise-wide view gallery. Shows enterprise-visible views with search,
 * filters, trending/popular, and favourites.
 */
import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  Search, Heart, Eye, Globe, Star, TrendingUp, Compass,
} from 'lucide-react'
import {
  listViews, listPopularViews, favouriteView, unfavouriteView,
  type View,
} from '@/services/viewApiService'

export function ExplorerPage() {
  const [views, setViews] = useState<View[]>([])
  const [popularViews, setPopularViews] = useState<View[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  const fetchViews = useCallback(async () => {
    setLoading(true)
    try {
      const [allViews, popular] = await Promise.all([
        listViews({
          visibility: 'enterprise',
          search: search || undefined,
        }),
        listPopularViews(10),
      ])
      setViews(allViews)
      setPopularViews(popular)
    } catch (err) {
      console.error('[ExplorerPage] Failed to load views:', err)
    } finally {
      setLoading(false)
    }
  }, [search])

  useEffect(() => {
    fetchViews()
  }, [fetchViews])

  const toggleFavourite = async (viewId: string, isFavourited: boolean) => {
    try {
      if (isFavourited) {
        await unfavouriteView(viewId)
      } else {
        await favouriteView(viewId)
      }
      fetchViews()
    } catch (err) {
      console.error('Failed to toggle favourite:', err)
    }
  }

  return (
    <div className="absolute inset-0 overflow-y-auto bg-canvas p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Compass className="w-6 h-6 text-accent-lineage" />
            <h1 className="text-2xl font-semibold text-ink-primary">Explorer</h1>
          </div>
          <p className="text-sm text-ink-secondary">
            Discover enterprise-shared views across your organization.
          </p>
        </div>

        {/* Search */}
        <div className="flex items-center gap-4 mb-6">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint" />
            <input
              type="text"
              placeholder="Search enterprise views..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 rounded-lg border border-chrome-300 bg-chrome-50 text-sm text-ink-primary placeholder:text-ink-faint focus:outline-none focus:border-accent-lineage"
            />
          </div>
        </div>

        {/* Popular section */}
        {popularViews.length > 0 && !search && (
          <section className="mb-8">
            <div className="flex items-center gap-2 mb-4">
              <TrendingUp className="w-4 h-4 text-amber-500" />
              <h2 className="text-sm font-semibold text-ink-primary">Trending</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {popularViews.map(v => (
                <ExplorerCard
                  key={v.id}
                  view={v}
                  onToggleFavourite={() => toggleFavourite(v.id, v.isFavourited)}
                />
              ))}
            </div>
          </section>
        )}

        {/* All enterprise views */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <Globe className="w-4 h-4 text-ink-secondary" />
            <h2 className="text-sm font-semibold text-ink-primary">
              {search ? `Results for "${search}"` : 'Enterprise Views'}
            </h2>
            <span className="text-xs text-ink-faint">({views.length})</span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-6 h-6 border-2 border-accent-lineage border-t-transparent rounded-full animate-spin" />
            </div>
          ) : views.length === 0 ? (
            <div className="text-center py-20 text-ink-secondary text-sm">
              {search ? 'No views match your search.' : 'No enterprise views available yet.'}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {views.map(v => (
                <ExplorerCard
                  key={v.id}
                  view={v}
                  onToggleFavourite={() => toggleFavourite(v.id, v.isFavourited)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function ExplorerCard({ view, onToggleFavourite }: {
  view: View
  onToggleFavourite: () => void
}) {
  return (
    <Link
      to={`/views/${view.id}`}
      className="group block glass-panel rounded-xl p-4 hover:border-accent-lineage/40 transition-all duration-200"
    >
      <div className="flex items-start justify-between mb-2">
        <h3 className="text-sm font-medium text-ink-primary truncate flex-1 group-hover:text-accent-lineage transition-colors">
          {view.name}
        </h3>
        <button
          onClick={e => { e.preventDefault(); e.stopPropagation(); onToggleFavourite() }}
          className="ml-2 p-1 rounded hover:bg-chrome-100 transition-colors"
        >
          <Heart
            className={`w-4 h-4 transition-colors ${
              view.isFavourited
                ? 'fill-red-500 text-red-500'
                : 'text-ink-faint group-hover:text-ink-secondary'
            }`}
          />
        </button>
      </div>

      {view.description && (
        <p className="text-xs text-ink-secondary line-clamp-2 mb-3">{view.description}</p>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Eye className="w-3 h-3 text-ink-faint" />
          <span className="text-[10px] text-ink-faint">{view.viewType}</span>
          {view.workspaceName && (
            <span className="text-[10px] text-ink-faint truncate max-w-[120px]">
              {view.workspaceName}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {view.favouriteCount > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] text-ink-faint">
              <Star className="w-3 h-3" />
              {view.favouriteCount}
            </span>
          )}
        </div>
      </div>

      {view.tags && view.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {view.tags.slice(0, 3).map(tag => (
            <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full bg-chrome-100 text-ink-secondary">
              {tag}
            </span>
          ))}
          {view.tags.length > 3 && (
            <span className="text-[10px] text-ink-faint">+{view.tags.length - 3}</span>
          )}
        </div>
      )}
    </Link>
  )
}
