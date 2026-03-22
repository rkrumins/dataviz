import { useState, useCallback, useMemo } from 'react'
import { DataSourceStats } from '@/hooks/useDashboardData'
import { type WorkspaceResponse, type DataSourceResponse } from '@/services/workspaceService'
import { useWorkspacesStore } from '@/store/workspaces'
import { useNavigationStore } from '@/store/navigation'
import { useSchemaViews } from '@/store/schema'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Search,
    ArrowRight,
    Database,
    Globe,
    ChevronRight,
    ChevronDown,
    Server,
    Eye,
    CircleDot,
    GitBranch,
    CheckCircle2,
    X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { WORKSPACE_PALETTES, compactNum } from './dashboard-constants'

// ───────────────────────────────────────────────────────────────────────────────
// Routing helper
// ───────────────────────────────────────────────────────────────────────────────
function useNavigateToWorkspace() {
    const setActiveWorkspace = useWorkspacesStore(s => s.setActiveWorkspace)
    const setActiveDataSource = useWorkspacesStore(s => s.setActiveDataSource)
    const setActiveTab = useNavigationStore(s => s.setActiveTab)
    return useCallback((wsId: string, dsId?: string) => {
        setActiveWorkspace(wsId)
        if (dsId) setActiveDataSource(dsId)
        setActiveTab('explore')
    }, [setActiveWorkspace, setActiveDataSource, setActiveTab])
}

// ───────────────────────────────────────────────────────────────────────────────
// Data Source Search Popover (inside workspace card)
// ───────────────────────────────────────────────────────────────────────────────
function DataSourceList({ dataSources, wsId, activeDataSourceId, isActiveWs, stats, onSelect, palette, viewsByDs }: {
    dataSources: DataSourceResponse[]
    wsId: string
    activeDataSourceId: string | null
    isActiveWs: boolean
    stats: Record<string, DataSourceStats>
    onSelect: (dsId: string) => void
    palette: typeof WORKSPACE_PALETTES[0]
    viewsByDs: Record<string, number>   // dsId -> view count
}) {
    const [query, setQuery] = useState('')
    const filtered = useMemo(() => {
        if (!query.trim()) return dataSources
        const q = query.toLowerCase()
        return dataSources.filter(ds =>
            (ds.label || '').toLowerCase().includes(q) ||
            (ds.graphName || '').toLowerCase().includes(q)
        )
    }, [dataSources, query])

    return (
        <div className="space-y-2">
            {/* Search for 5+ sources */}
            {dataSources.length >= 5 && (
                <div className="relative mb-3">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted pointer-events-none" />
                    <input
                        type="text"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="Find data source…"
                        className="w-full pl-8 pr-8 py-2 text-sm bg-black/5 dark:bg-white/5 border border-glass-border rounded-xl text-ink placeholder:text-ink-muted/50 outline-none focus:border-accent-business/40 focus:bg-accent-business/5 transition-all"
                    />
                    {query && (
                        <button onClick={() => setQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink">
                            <X className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
            )}
            <div className="space-y-1.5 max-h-52 overflow-y-auto scrollbar-thin scrollbar-thumb-glass-border pr-0.5">
                {filtered.length === 0 && (
                    <p className="text-xs text-ink-muted text-center py-3">No sources match "{query}"</p>
                )}
                {filtered.map((ds) => {
                    const key = `${wsId}/${ds.id}`
                    const dsStats = stats[key]
                    const isActive = isActiveWs && ds.id === activeDataSourceId
                    const viewCount = viewsByDs[ds.id] ?? 0
                    return (
                        <button
                            key={ds.id}
                            onClick={() => onSelect(ds.id)}
                            className={cn(
                                'relative w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-left group/ds overflow-hidden',
                                isActive
                                    ? 'bg-accent-business/10 border border-accent-business/30'
                                    : 'bg-black/5 dark:bg-white/5 border border-transparent hover:border-glass-border hover:bg-black/8'
                            )}
                        >
                            {isActive && <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-accent-business rounded-full" />}
                            <div className={cn('w-7 h-7 rounded-lg border flex items-center justify-center shrink-0',
                                isActive ? 'bg-accent-business/10 border-accent-business/30 text-accent-business' : palette.icon)}>
                                <Database className="w-3.5 h-3.5" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className={cn('text-sm font-semibold truncate', isActive ? 'text-accent-business' : 'text-ink')}>
                                        {ds.label || ds.graphName || 'Unnamed Source'}
                                    </span>
                                    {ds.isPrimary && (
                                        <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-500 border border-emerald-500/20 bg-emerald-500/10 rounded-full px-1.5 py-0.5 shrink-0">Primary</span>
                                    )}
                                    {isActive && (
                                        <span className="text-[9px] font-bold uppercase tracking-wider text-accent-business border border-accent-business/20 bg-accent-business/10 rounded-full px-1.5 py-0.5 shrink-0">Active</span>
                                    )}
                                </div>
                                {ds.graphName && ds.label && ds.graphName !== ds.label && (
                                    <span className="text-[11px] text-ink-muted/70 font-mono block truncate">{ds.graphName}</span>
                                )}
                            </div>
                            {/* Stats column: nodes · edges · views */}
                            <div className="flex flex-col items-end shrink-0 gap-0.5">
                                {dsStats ? (
                                    <>
                                        <span className="text-xs font-bold text-ink tabular-nums">{dsStats.nodeCount.toLocaleString()} <span className="text-ink-muted/50 font-normal text-[10px]">nodes</span></span>
                                        <span className="text-[10px] text-ink-muted tabular-nums">{dsStats.edgeCount.toLocaleString()} <span className="opacity-50">edges</span></span>
                                    </>
                                ) : (
                                    <span className="text-xs text-ink-muted/30">—</span>
                                )}
                                {viewCount > 0 && (
                                    <span className="flex items-center gap-0.5 text-[10px] font-bold text-violet-500 tabular-nums">
                                        <Eye className="w-2.5 h-2.5" />{viewCount} view{viewCount !== 1 ? 's' : ''}
                                    </span>
                                )}
                            </div>
                        </button>
                    )
                })}
            </div>
        </div>
    )
}

// ───────────────────────────────────────────────────────────────────────────────
// Workspace Card — full-size, spacious design
// ───────────────────────────────────────────────────────────────────────────────
function WorkspaceCard({ ws, index, dataSourceStats, isActive, activeDataSourceId, onSelect, viewsByScope }: {
    ws: WorkspaceResponse
    index: number
    dataSourceStats: Record<string, DataSourceStats>
    isActive: boolean
    activeDataSourceId: string | null
    onSelect: (wsId: string) => void
    viewsByScope: Record<string, number>  // scopeKey (wsId/dsId) -> count
}) {
    const [expanded, setExpanded] = useState(isActive)
    const palette = WORKSPACE_PALETTES[index % WORKSPACE_PALETTES.length]
    const dataSources = ws.dataSources || []
    const dsCount = dataSources.length
    const isOnline = ws.isActive && dsCount > 0
    const navigateTo = useNavigateToWorkspace()

    const totalNodes = dataSources.reduce((acc, ds) => acc + (dataSourceStats[`${ws.id}/${ds.id}`]?.nodeCount ?? 0), 0)
    const totalEdges = dataSources.reduce((acc, ds) => acc + (dataSourceStats[`${ws.id}/${ds.id}`]?.edgeCount ?? 0), 0)

    // Count views scoped to this workspace (across all its data sources)
    const totalViews = dataSources.reduce((acc, ds) => acc + (viewsByScope[`${ws.id}/${ds.id}`] ?? 0), 0)

    // Per-DS view counts for DataSourceList
    const viewsByDs: Record<string, number> = {}
    dataSources.forEach(ds => { viewsByDs[ds.id] = viewsByScope[`${ws.id}/${ds.id}`] ?? 0 })

    const handleOpenCanvas = (e: React.MouseEvent) => {
        e.stopPropagation()
        const primaryDs = dataSources.find(d => d.isPrimary) ?? dataSources[0]
        navigateTo(ws.id, primaryDs?.id)
    }

    const handleSelectDs = (dsId: string) => navigateTo(ws.id, dsId)

    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.04, duration: 0.25, ease: 'easeOut' }}
            className={cn(
                'group relative flex flex-col glass-panel rounded-3xl border overflow-hidden transition-all duration-300',
                isActive
                    ? 'border-accent-business/50 shadow-xl shadow-accent-business/10'
                    : cn('border-glass-border hover:-translate-y-1 hover:shadow-2xl', palette.ring, palette.shadow)
            )}
        >
            {/* Top accent bar */}
            <div className={cn(
                'h-1 w-full transition-all duration-300',
                isActive ? 'bg-accent-business opacity-100' : cn(palette.accent, 'opacity-50 group-hover:opacity-100')
            )} />

            <div className="p-6 flex flex-col flex-1">
                {/* Header — name + badges + SELECT button top-right */}
                <div className="flex items-start gap-3.5 mb-4">
                    <div className={cn(
                        'w-14 h-14 rounded-2xl border flex items-center justify-center shrink-0 font-bold text-xl group-hover:scale-105 transition-transform duration-300',
                        isActive ? 'bg-accent-business/10 border-accent-business/30 text-accent-business' : palette.icon
                    )}>
                        {ws.name.substring(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1 pt-0.5">
                        <div className="flex items-start justify-between gap-2 mb-1">
                            <div className="min-w-0">
                                <h4 className="font-bold text-lg text-ink leading-tight truncate">{ws.name}</h4>
                                <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                                    {ws.isDefault && (
                                        <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest bg-accent-business/10 text-accent-business border border-accent-business/20">
                                            Default
                                        </span>
                                    )}
                                    {isActive && (
                                        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                                            <CheckCircle2 className="w-2.5 h-2.5" /> Selected
                                        </span>
                                    )}
                                </div>
                            </div>
                            {/* Select button — activates workspace, shows views below WITHOUT navigating */}
                            <button
                                onClick={(e) => { e.stopPropagation(); onSelect(ws.id) }}
                                className={cn(
                                    'shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all border',
                                    isActive
                                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400 cursor-default'
                                        : cn('border-glass-border bg-black/5 dark:bg-white/5 hover:bg-black/10', palette.label)
                                )}
                            >
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                {isActive ? 'Selected' : 'Select'}
                            </button>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <span className={cn(
                                'w-2 h-2 rounded-full shrink-0',
                                isOnline ? 'bg-emerald-500 shadow-[0_0_6px_rgba(34,197,94,0.7)] animate-pulse' : 'bg-slate-400'
                            )} />
                            <span className="text-xs font-medium text-ink-muted">
                                {isOnline ? 'Online · All sources active' : 'Standby'}
                            </span>
                        </div>
                    </div>
                </div>

                {/* Description */}
                {ws.description && (
                    <p className="text-xs text-ink-muted leading-relaxed mb-4 line-clamp-2">{ws.description}</p>
                )}

                {/* Stats grid — 4 cols: Sources · Nodes · Edges · Views */}
                <div className="grid grid-cols-4 gap-px bg-glass-border rounded-2xl overflow-visible mb-5">
                    {[
                        { val: dsCount, lbl: 'Sources', sub: 'data sources', icon: Server, tip: 'Connected data pipelines feeding this workspace' },
                        { val: totalNodes, lbl: 'Nodes', sub: 'total entities', icon: CircleDot, tip: 'Unique entities tracked across all data sources' },
                        { val: totalEdges, lbl: 'Edges', sub: 'relationships', icon: GitBranch, tip: 'Relationships and lineage connections mapped' },
                        { val: totalViews, lbl: 'Views', sub: 'context views', icon: Eye, tip: 'Saved context views scoped to this workspace' },
                    ].map(s => (
                        <div
                            key={s.lbl}
                            className="relative group/stat bg-canvas/80 dark:bg-canvas/60 px-3 py-3 flex flex-col gap-1 cursor-default"
                        >
                            {/* Custom tooltip — appears below the stat tile */}
                            {s.val > 0 && (
                                <div className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-2.5 z-50
                                                opacity-0 group-hover/stat:opacity-100 -translate-y-1 group-hover/stat:translate-y-0
                                                transition-all duration-200 ease-out w-44">
                                    {/* Caret pointing up */}
                                    <div className="w-3 h-3 mx-auto mb-[-6px] rotate-45 bg-canvas/98 dark:bg-[#111]/95 border-t border-l border-glass-border rounded-tl-sm" />
                                    <div className="bg-canvas/98 dark:bg-[#111]/95 backdrop-blur-2xl rounded-2xl border border-glass-border shadow-2xl shadow-black/20 px-3.5 py-3">
                                        <div className="text-base font-black text-ink tabular-nums tracking-tight">
                                            {s.val.toLocaleString()}
                                        </div>
                                        <div className="text-[11px] font-semibold text-ink-muted mt-0.5 leading-snug">
                                            {s.tip}
                                        </div>
                                    </div>
                                </div>
                            )}


                            <div className="flex items-center gap-1.5">
                                <s.icon className="w-3 h-3 text-ink-muted shrink-0" />
                                <span className="text-[9px] uppercase font-black tracking-widest text-ink-muted">{s.lbl}</span>
                            </div>
                            <span className={cn('text-2xl font-black leading-none tabular-nums',
                                s.lbl === 'Views' && s.val > 0
                                    ? 'text-violet-500'
                                    : s.val > 0 ? (isActive ? 'text-accent-business' : palette.label) : 'text-ink-muted/30'
                            )}>
                                {s.val > 0 ? compactNum(s.val) : '—'}
                            </span>
                            <span className="text-[10px] text-ink-muted/60">{s.sub}</span>
                        </div>
                    ))}
                </div>


                {/* Data sources toggle */}
                <button
                    onClick={() => setExpanded(e => !e)}
                    className="w-full flex items-center justify-between px-4 py-3 rounded-2xl bg-black/5 dark:bg-white/5 border border-glass-border/50 hover:bg-black/10 dark:hover:bg-white/10 transition-all mb-3 group/btn"
                >
                    <div className="flex items-center gap-2">
                        <Database className="w-4 h-4 text-ink-muted" />
                        <span className="text-sm font-semibold text-ink">
                            {dsCount > 0 ? `${dsCount} Data Source${dsCount !== 1 ? 's' : ''}` : 'No sources configured'}
                        </span>
                    </div>
                    <ChevronDown className={cn('w-4 h-4 text-ink-muted transition-transform duration-300', expanded ? 'rotate-180' : '')} />
                </button>

                <AnimatePresence>
                    {expanded && dsCount > 0 && (
                        <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.2, ease: 'easeInOut' }}
                            className="overflow-hidden mb-3"
                        >
                            <DataSourceList
                                dataSources={dataSources}
                                wsId={ws.id}
                                activeDataSourceId={activeDataSourceId}
                                isActiveWs={isActive}
                                stats={dataSourceStats}
                                onSelect={handleSelectDs}
                                palette={palette}
                                viewsByDs={viewsByDs}
                            />
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* CTA — opens canvas */}
                <button
                    onClick={handleOpenCanvas}
                    className={cn(
                        'mt-auto flex items-center justify-between w-full px-4 py-2.5 rounded-xl text-sm font-semibold transition-all border group/cta',
                        isActive
                            ? 'bg-accent-business text-white border-accent-business shadow-lg shadow-accent-business/20 hover:bg-accent-business-hover'
                            : cn('bg-transparent border-glass-border/50 hover:border-glass-border', palette.label)
                    )}
                >
                    <span>{isActive ? 'Open canvas' : 'Open canvas'}</span>
                    <ArrowRight className="w-4 h-4 group-hover/cta:translate-x-0.5 transition-transform" />
                </button>
            </div>
        </motion.div>
    )
}

// ───────────────────────────────────────────────────────────────────────────────
// Active Environments — 3-col grid, 6 per page with pagination
// ───────────────────────────────────────────────────────────────────────────────
export function WorkspaceGrid({ workspaces, dataSourceStats }: {
    workspaces: WorkspaceResponse[]
    dataSourceStats: Record<string, DataSourceStats>
}) {
    const activeWorkspaceId = useWorkspacesStore(s => s.activeWorkspaceId)
    const activeDataSourceId = useWorkspacesStore(s => s.activeDataSourceId)
    const setActiveWorkspace = useWorkspacesStore(s => s.setActiveWorkspace)
    // Safely read schema views (stable: only recomputes when view count changes)
    const schemaViews = useSchemaViews()
    const [wsQuery, setWsQuery] = useState('')
    const [page, setPage] = useState(0)

    // Build scopeKey -> viewCount map from all known views
    const viewsByScope = useMemo(() => {
        const map: Record<string, number> = {}
        schemaViews.forEach(v => {
            if (v.scopeKey) map[v.scopeKey] = (map[v.scopeKey] ?? 0) + 1
        })
        return map
    }, [schemaViews])

    const PAGE_SIZE = 6

    const filteredWorkspaces = useMemo(() => {
        const sorted = [...workspaces].sort((a, b) =>
            a.id === activeWorkspaceId ? -1 : b.id === activeWorkspaceId ? 1 : 0
        )
        if (!wsQuery.trim()) return sorted
        const q = wsQuery.toLowerCase()
        return sorted.filter(ws =>
            ws.name.toLowerCase().includes(q) ||
            ws.description?.toLowerCase().includes(q)
        )
    }, [workspaces, activeWorkspaceId, wsQuery])

    // Reset to page 0 when search changes
    const handleSearch = (q: string) => {
        setWsQuery(q)
        setPage(0)
    }

    if (!workspaces || workspaces.length === 0) return null

    const totalSources = workspaces.reduce((acc, w) => acc + (w.dataSources?.length || 0), 0)
    const isSearching = wsQuery.trim().length > 0
    const totalPages = Math.ceil(filteredWorkspaces.length / PAGE_SIZE)
    // While searching show all results; while paginating slice by page
    const visibleWorkspaces = isSearching
        ? filteredWorkspaces
        : filteredWorkspaces.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

    const handleSelectWorkspace = (wsId: string) => setActiveWorkspace(wsId)

    return (
        <section className="mb-20 px-4 md:px-0">
            {/* Header */}
            <div className="flex items-end justify-between mb-8">
                <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-2xl bg-gradient-to-br from-accent-business/20 to-accent-explore/10 border border-accent-business/25">
                        <Globe className="w-5 h-5 text-accent-business" />
                    </div>
                    <div>
                        <h2 className="text-2xl font-bold text-ink tracking-tight">Active Environments</h2>
                        <p className="text-sm text-ink-muted mt-0.5">
                            {workspaces.length} workspace{workspaces.length !== 1 ? 's' : ''} · {totalSources} total data source{totalSources !== 1 ? 's' : ''}
                            {activeWorkspaceId && <span className="text-accent-business font-semibold"> · 1 active</span>}
                        </p>
                    </div>
                </div>

                {/* Search */}
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted pointer-events-none" />
                    <input
                        type="text"
                        value={wsQuery}
                        onChange={e => handleSearch(e.target.value)}
                        placeholder="Find workspace…"
                        className="pl-9 pr-8 py-2 text-sm bg-black/5 dark:bg-white/5 border border-glass-border rounded-xl text-ink placeholder:text-ink-muted/50 outline-none focus:border-accent-business/40 w-48 transition-all focus:w-60"
                    />
                    {wsQuery && (
                        <button onClick={() => handleSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2">
                            <X className="w-3.5 h-3.5 text-ink-muted hover:text-ink" />
                        </button>
                    )}
                </div>
            </div>

            {/* Grid */}
            {visibleWorkspaces.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-14 rounded-3xl border-2 border-dashed border-glass-border">
                    <Search className="w-10 h-10 text-ink-muted/30 mb-3" />
                    <p className="text-sm font-semibold text-ink mb-1">No workspaces found</p>
                    <p className="text-xs text-ink-muted">Try a different search term</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {visibleWorkspaces.map((ws, i) => (
                        <WorkspaceCard
                            key={ws.id}
                            ws={ws}
                            index={i}
                            dataSourceStats={dataSourceStats}
                            isActive={ws.id === activeWorkspaceId}
                            activeDataSourceId={activeDataSourceId}
                            onSelect={handleSelectWorkspace}
                            viewsByScope={viewsByScope}
                        />
                    ))}
                </div>
            )}

            {/* Pagination — only shown when not searching and more than one page */}
            {!isSearching && totalPages > 1 && (
                <div className="flex items-center justify-center gap-3 mt-8">
                    <button
                        onClick={() => setPage(p => Math.max(0, p - 1))}
                        disabled={page === 0}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold border border-glass-border bg-black/5 dark:bg-white/5 text-ink-muted disabled:opacity-30 disabled:cursor-not-allowed hover:enabled:bg-black/10 hover:enabled:text-ink transition-all"
                    >
                        <ChevronRight className="w-4 h-4 rotate-180" /> Previous
                    </button>

                    <div className="flex items-center gap-1.5">
                        {Array.from({ length: totalPages }).map((_, i) => (
                            <button
                                key={i}
                                onClick={() => setPage(i)}
                                className={cn(
                                    'w-8 h-8 rounded-lg text-sm font-bold transition-all',
                                    i === page
                                        ? 'bg-accent-business text-white shadow-md shadow-accent-business/20'
                                        : 'text-ink-muted hover:text-ink hover:bg-black/10 dark:hover:bg-white/10'
                                )}
                            >
                                {i + 1}
                            </button>
                        ))}
                    </div>

                    <button
                        onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                        disabled={page === totalPages - 1}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold border border-glass-border bg-black/5 dark:bg-white/5 text-ink-muted disabled:opacity-30 disabled:cursor-not-allowed hover:enabled:bg-black/10 hover:enabled:text-ink transition-all"
                    >
                        Next <ChevronRight className="w-4 h-4" />
                    </button>
                </div>
            )}

            {/* Search result count */}
            {isSearching && filteredWorkspaces.length > 0 && (
                <p className="text-xs text-ink-muted/60 mt-4 text-center">
                    {filteredWorkspaces.length} result{filteredWorkspaces.length !== 1 ? 's' : ''} for "{wsQuery}"
                </p>
            )}
        </section>
    )
}
