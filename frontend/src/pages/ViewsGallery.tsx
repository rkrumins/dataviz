/**
 * Views gallery page: /views
 * Browse and discover all accessible views with search, filters, and favourites.
 */
import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Search, Heart, Eye, Globe, Lock, Users, Star, LayoutGrid, TrendingUp } from 'lucide-react'
import { viewsApi, type ViewApiResponse } from '@/services/viewsApiService'

export function ViewsGallery() {
  const [views, setViews] = useState<ViewApiResponse[]>([])
  const [popularViews, setPopularViews] = useState<ViewApiResponse[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [activeFilter, setActiveFilter] = useState<string | null>(null)

  const fetchViews = useCallback(async () => {
    setLoading(true)
    try {
      const [allViews, popular] = await Promise.all([
        viewsApi.list({
          search: search || undefined,
          visibility: activeFilter || undefined,
        }),
        viewsApi.listPopular(10),
      ])
      setViews(allViews)
      setPopularViews(popular)
    } catch (err) {
      console.error('[ViewsGallery] Failed to load views:', err)
    } finally {
      setLoading(false)
    }
  }, [search, activeFilter])

  useEffect(() => {
    fetchViews()
  }, [fetchViews])

  const toggleFavourite = async (viewId: string, isFavourited: boolean) => {
    try {
      if (isFavourited) {
        await viewsApi.unfavourite(viewId)
      } else {
        await viewsApi.favourite(viewId)
      }
      // Refresh
      fetchViews()
    } catch (err) {
      console.error('Failed to toggle favourite:', err)
    }
  }

  const visibilityFilters = [
    { key: null, label: 'All', icon: LayoutGrid },
    { key: 'enterprise', label: 'Enterprise', icon: Globe },
    { key: 'workspace', label: 'Workspace', icon: Users },
    { key: 'private', label: 'Private', icon: Lock },
  ]

  return (
    <div className="absolute inset-0 overflow-y-auto bg-canvas p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-ink-primary mb-2">Views</h1>
          <p className="text-sm text-ink-secondary">
            Browse, discover, and favourite views shared across your organization.
          </p>
        </div>

        {/* Search and Filters */}
        <div className="flex items-center gap-4 mb-6">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint" />
            <input
              type="text"
              placeholder="Search views..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 rounded-lg border border-chrome-300 bg-chrome-50 text-sm text-ink-primary placeholder:text-ink-faint focus:outline-none focus:border-accent-lineage"
            />
          </div>

          <div className="flex items-center gap-1">
            {visibilityFilters.map(f => {
              const Icon = f.icon
              return (
                <button
                  key={f.key ?? 'all'}
                  onClick={() => setActiveFilter(f.key)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    activeFilter === f.key
                      ? 'bg-accent-lineage/20 text-accent-lineage'
                      : 'text-ink-secondary hover:bg-chrome-100'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {f.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Popular section */}
        {popularViews.length > 0 && !search && !activeFilter && (
          <section className="mb-8">
            <div className="flex items-center gap-2 mb-4">
              <TrendingUp className="w-4 h-4 text-amber-500" />
              <h2 className="text-sm font-semibold text-ink-primary">Popular</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {popularViews.map(v => (
                <ViewCard
                  key={v.id}
                  view={v}
                  onToggleFavourite={() => toggleFavourite(v.id, v.isFavourited)}
                />
              ))}
            </div>
          </section>
        )}

        {/* All views */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <Eye className="w-4 h-4 text-ink-secondary" />
            <h2 className="text-sm font-semibold text-ink-primary">
              {search ? `Results for "${search}"` : 'All Views'}
            </h2>
            <span className="text-xs text-ink-faint">({views.length})</span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-6 h-6 border-2 border-accent-lineage border-t-transparent rounded-full animate-spin" />
            </div>
          ) : views.length === 0 ? (
            <div className="text-center py-20 text-ink-secondary text-sm">
              {search ? 'No views match your search.' : 'No views available yet.'}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {views.map(v => (
                <ViewCard
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

function ViewCard({ view, onToggleFavourite }: {
  view: ViewApiResponse
  onToggleFavourite: () => void
}) {
  const visibilityIcon = {
    enterprise: Globe,
    workspace: Users,
    private: Lock,
  }[view.visibility] || Eye
  const VisIcon = visibilityIcon

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
          <VisIcon className="w-3 h-3 text-ink-faint" />
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
