import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Eye, Search, Plus, ExternalLink, Compass } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DataSourceResponse } from '@/services/workspaceService'
import type { View } from '@/services/viewApiService'

interface WorkspaceViewsSectionProps {
    wsId: string
    dataSources: DataSourceResponse[]
    views: View[]
}

export default function WorkspaceViewsSection({ wsId, dataSources, views }: WorkspaceViewsSectionProps) {
    const [dsFilter, setDsFilter] = useState<string>('all')
    const [searchQuery, setSearchQuery] = useState('')

    const filteredViews = useMemo(() => {
        let result = views
        if (dsFilter !== 'all') result = result.filter(v => v.dataSourceId === dsFilter)
        if (searchQuery) {
            const q = searchQuery.toLowerCase()
            result = result.filter(v => v.name.toLowerCase().includes(q) || v.description?.toLowerCase().includes(q))
        }
        return result
    }, [views, dsFilter, searchQuery])

    return (
        <section>
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                    <h3 className="text-lg font-bold text-ink">Views</h3>
                    <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-indigo-500/10 text-indigo-500">
                        {views.length}
                    </span>
                </div>
                <Link
                    to={`/explorer?workspace=${wsId}`}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors"
                >
                    <Plus className="w-4 h-4" /> Create View
                </Link>
            </div>

            {/* Filter bar */}
            <div className="flex items-center gap-3 mb-4">
                <select
                    value={dsFilter}
                    onChange={e => setDsFilter(e.target.value)}
                    className="px-3 py-2 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                >
                    <option value="all">All Sources</option>
                    {dataSources.map(ds => (
                        <option key={ds.id} value={ds.id}>{ds.label || ds.catalogItemId}</option>
                    ))}
                </select>
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                    <input
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        placeholder="Search views..."
                        className="w-full pl-9 pr-4 py-2 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    />
                </div>
            </div>

            {/* View cards grid */}
            {filteredViews.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {filteredViews.map(view => (
                        <Link
                            key={view.id}
                            to={`/views/${view.id}`}
                            className="block p-4 rounded-xl border border-glass-border bg-canvas-elevated hover:border-indigo-500/20 hover:shadow-sm transition-all group"
                        >
                            <div className="flex items-center gap-3 mb-2">
                                <div className="w-8 h-8 rounded-lg bg-cyan-500/10 text-cyan-500 flex items-center justify-center shrink-0">
                                    <Eye className="w-4 h-4" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <h4 className="text-sm font-semibold text-ink truncate">{view.name}</h4>
                                </div>
                                {view.isPinned && (
                                    <span className="px-1.5 py-0.5 text-[8px] font-bold rounded bg-amber-500/10 text-amber-500">PINNED</span>
                                )}
                                <ExternalLink className="w-3 h-3 text-ink-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                            </div>

                            {view.description && (
                                <p className="text-xs text-ink-muted line-clamp-2 mb-3">{view.description}</p>
                            )}

                            <div className="flex flex-wrap items-center gap-2 mb-2">
                                {view.layoutType && (
                                    <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-black/5 dark:bg-white/5 text-ink-muted border border-glass-border">
                                        {view.layoutType}
                                    </span>
                                )}
                                <span className={cn(
                                    'px-1.5 py-0.5 text-[9px] font-medium rounded border',
                                    view.visibility === 'enterprise' ? 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20' :
                                    view.visibility === 'workspace' ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' :
                                    'bg-black/5 dark:bg-white/5 text-ink-muted border-glass-border'
                                )}>
                                    {view.visibility}
                                </span>
                                {view.dataSourceName && (
                                    <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-violet-500/10 text-violet-500 border border-violet-500/20">
                                        {view.dataSourceName}
                                    </span>
                                )}
                            </div>

                            <div className="flex items-center gap-3 text-[10px] text-ink-muted">
                                <span>{'\u2665'} {view.favouriteCount}</span>
                                <span>{new Date(view.updatedAt).toLocaleDateString()}</span>
                                {view.createdBy && (
                                    <span className="ml-auto truncate max-w-[120px]">{view.createdBy}</span>
                                )}
                            </div>
                        </Link>
                    ))}
                </div>
            ) : (
                <div className="py-16 text-center border-2 border-dashed border-glass-border rounded-2xl">
                    <Eye className="w-10 h-10 mx-auto text-ink-muted mb-3 opacity-30" />
                    <h4 className="text-sm font-bold text-ink mb-1">
                        {searchQuery || dsFilter !== 'all' ? 'No matching views' : 'No views yet'}
                    </h4>
                    <p className="text-xs text-ink-muted mb-4">
                        {searchQuery || dsFilter !== 'all' ? 'Try different filters' : 'Create a view to get started'}
                    </p>
                    <Link
                        to={`/explorer?workspace=${wsId}`}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors"
                    >
                        <Compass className="w-4 h-4" /> Open Explorer
                    </Link>
                </div>
            )}
        </section>
    )
}
