import { useRef, useState, useCallback, useMemo } from 'react'
import { DashboardStats as StatsType, TemplateBrief, BlueprintBrief, DataSourceStats } from '@/hooks/useDashboardData'
import { type WorkspaceResponse, type DataSourceResponse } from '@/services/workspaceService'
import { useWorkspacesStore } from '@/store/workspaces'
import { useNavigationStore } from '@/store/navigation'
import { useSchemaStore } from '@/store/schema'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Search,
    ArrowRight,
    LayoutTemplate,
    Database,
    Network,
    Component,
    Monitor,
    Zap,
    Globe,
    ChevronRight,
    ChevronDown,
    Server,
    Eye,
    Clock,
    TrendingUp,
    Star,
    Layers,
    GitBranch,
    BarChart3,
    CircleDot,
    Sparkles,
    BookOpen,
    Package,
    CheckCircle2,
    X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { type ViewConfiguration } from '@/types/schema'

// ───────────────────────────────────────────────────────────────────────────────
// Routing helpers
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

function useOpenView() {
    const setActiveView = useSchemaStore(s => s.setActiveView)
    const setActiveTab = useNavigationStore(s => s.setActiveTab)
    return useCallback((viewId: string) => {
        setActiveView(viewId)
        setActiveTab('explore')
    }, [setActiveView, setActiveTab])
}

// ───────────────────────────────────────────────────────────────────────────────
// Hero Search — controlled with live results dropdown
// ───────────────────────────────────────────────────────────────────────────────
const QUICK_SUGGESTIONS = [
    { icon: TrendingUp, label: 'Sales Pipeline', category: 'Model' },
    { icon: Globe, label: 'Customer 360', category: 'View' },
    { icon: Network, label: 'Data Lineage', category: 'Explore' },
    { icon: Star, label: 'Templates', category: 'Library' },
]

export type DashboardSearchResult = {
    id: string
    label: string
    sublabel?: string
    category: 'Workspace' | 'Data Source' | 'View' | 'Template'
    icon: React.ComponentType<{ className?: string }>
    onSelect: () => void
}

const CATEGORY_COLORS: Record<DashboardSearchResult['category'], string> = {
    Workspace: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20',
    'Data Source': 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
    View: 'bg-violet-500/10 text-violet-500 border-violet-500/20',
    Template: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
}

export function DashboardHero({ value, onChange, results }: {
    value: string
    onChange: (q: string) => void
    results: DashboardSearchResult[]
}) {
    const [focused, setFocused] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const showDropdown = focused && value.trim().length > 0

    // Close dropdown when clicking outside
    const handleBlur = () => {
        // Delay so click on result fires first
        setTimeout(() => setFocused(false), 150)
    }

    return (
        <section className="relative w-full flex flex-col items-center justify-center pt-14 pb-10 px-4 text-center overflow-visible">
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="w-[900px] h-[400px] bg-accent-business/8 blur-[140px] rounded-[100%]" />
            </div>
            <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
                className="relative z-10 w-full max-w-2xl"
            >
                <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.1, duration: 0.5 }}
                    className="inline-flex items-center gap-2 mb-5 px-4 py-1.5 rounded-full glass-panel border border-accent-business/30 text-accent-business text-sm font-semibold"
                >
                    <Zap className="w-3.5 h-3.5" />
                    Data Intelligence Platform
                </motion.div>
                <h1 className="text-4xl md:text-5xl font-extrabold text-ink tracking-tight mb-3 leading-[1.1]">
                    What would you like<br className="hidden md:block" /> to{' '}
                    <span className="bg-gradient-to-r from-accent-business to-accent-explore bg-clip-text text-transparent">
                        explore?
                    </span>
                </h1>
                <p className="text-base text-ink-muted mb-8 max-w-md mx-auto">
                    Search across workspaces, views, and data sources — or jump to a template.
                </p>

                {/* Search box + dropdown */}
                <div ref={containerRef} className={cn('relative group transition-all duration-500', focused ? 'scale-[1.02]' : 'scale-100')}>
                    {/* Glow */}
                    <div className={cn(
                        'absolute -inset-1 rounded-3xl blur-md transition-opacity duration-700',
                        focused
                            ? 'opacity-100 bg-gradient-to-r from-accent-business/40 via-accent-explore/30 to-accent-lineage/40'
                            : 'opacity-0 group-hover:opacity-50 bg-gradient-to-r from-accent-business/20 to-accent-lineage/10'
                    )} />

                    {/* Input bar */}
                    <div className={cn(
                        'relative flex items-center bg-canvas/95 backdrop-blur-2xl border shadow-2xl transition-all duration-300 overflow-hidden',
                        showDropdown ? 'rounded-t-2xl rounded-b-none border-accent-business/60 border-b-glass-border/30' : 'rounded-2xl',
                        focused && !showDropdown ? 'border-accent-business/60' : !focused ? 'border-glass-border' : ''
                    )}>
                        <Search className={cn('w-6 h-6 ml-5 shrink-0 transition-colors duration-200', focused ? 'text-accent-business' : 'text-ink-muted')} />
                        <input
                            ref={inputRef}
                            type="text"
                            value={value}
                            onChange={e => onChange(e.target.value)}
                            onFocus={() => setFocused(true)}
                            onBlur={handleBlur}
                            placeholder="Search workspaces, views, data sources, templates…"
                            className="flex-1 bg-transparent border-none py-5 px-4 text-lg text-ink outline-none placeholder:text-ink-muted/40 font-medium"
                        />
                        {value && (
                            <button
                                onMouseDown={e => { e.preventDefault(); onChange('') }}
                                className="mr-2 w-7 h-7 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/10 transition-all"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        )}
                        <div className="mr-4">
                            <kbd className="hidden sm:flex items-center gap-1 rounded-lg border border-glass-border bg-black/5 dark:bg-white/5 px-2.5 py-1 text-sm font-medium text-ink-muted">
                                <span className="text-base leading-none">⌘</span>K
                            </kbd>
                        </div>
                    </div>

                    {/* Results dropdown */}
                    <AnimatePresence>
                        {showDropdown && (
                            <motion.div
                                initial={{ opacity: 0, y: -4 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -4 }}
                                transition={{ duration: 0.15 }}
                                className="absolute left-0 right-0 top-full z-50 bg-canvas/98 backdrop-blur-2xl border border-t-0 border-accent-business/40 rounded-b-2xl shadow-2xl max-h-80 overflow-y-auto"
                            >
                                {results.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center py-10 gap-2">
                                        <Search className="w-7 h-7 text-ink-muted/30" />
                                        <p className="text-sm font-semibold text-ink">No results for "{value}"</p>
                                        <p className="text-xs text-ink-muted">Try a workspace name, view, or data source</p>
                                    </div>
                                ) : (
                                    <div className="py-2">
                                        {results.map((r, i) => (
                                            <button
                                                key={r.id}
                                                onMouseDown={e => { e.preventDefault(); r.onSelect(); onChange('') }}
                                                className={cn(
                                                    'w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-black/5 dark:hover:bg-white/5 transition-colors group/res',
                                                    i > 0 && results[i - 1].category !== r.category ? 'border-t border-glass-border/40' : ''
                                                )}
                                            >
                                                <div className={cn('w-8 h-8 rounded-xl border flex items-center justify-center shrink-0', CATEGORY_COLORS[r.category])}>
                                                    <r.icon className="w-4 h-4" />
                                                </div>
                                                <div className="flex-1 min-w-0 text-left">
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-sm font-semibold text-ink group-hover/res:text-accent-business transition-colors truncate">{r.label}</span>
                                                        <span className={cn('text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border shrink-0', CATEGORY_COLORS[r.category])}>{r.category}</span>
                                                    </div>
                                                    {r.sublabel && <p className="text-xs text-ink-muted truncate mt-0.5">{r.sublabel}</p>}
                                                </div>
                                                <ArrowRight className="w-4 h-4 text-ink-muted/0 group-hover/res:text-accent-business transition-all group-hover/res:translate-x-0.5 shrink-0" />
                                            </button>
                                        ))}
                                    </div>
                                )}
                                <div className="px-4 py-2 border-t border-glass-border/30 flex items-center justify-between">
                                    <span className="text-[11px] text-ink-muted">{results.length} result{results.length !== 1 ? 's' : ''}</span>
                                    <span className="text-[11px] text-ink-muted">↵ to select · Esc to close</span>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>

                {/* Quick suggestions — hide while searching */}
                {!value && (
                    <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                        <span className="text-[11px] font-bold text-ink-muted uppercase tracking-widest mr-1">Jump to:</span>
                        {QUICK_SUGGESTIONS.map((s, i) => (
                            <motion.button
                                key={s.label}
                                initial={{ opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: 0.4 + i * 0.08 }}
                                className="group flex items-center gap-1.5 px-3.5 py-1.5 rounded-full glass-panel border border-glass-border text-sm font-medium text-ink-muted hover:text-accent-business hover:border-accent-business/40 hover:bg-accent-business/5 transition-all"
                            >
                                <s.icon className="w-3.5 h-3.5 group-hover:scale-110 transition-transform" />
                                {s.label}
                            </motion.button>
                        ))}
                    </div>
                )}
            </motion.div>
        </section>
    )
}



// ───────────────────────────────────────────────────────────────────────────────
// Insight Cards
// ───────────────────────────────────────────────────────────────────────────────
const CARD_THEMES = [
    { gradient: 'from-indigo-500/20 to-indigo-500/0', iconBg: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-500', valueCls: 'text-indigo-600 dark:text-indigo-400', border: 'hover:border-indigo-500/40' },
    { gradient: 'from-rose-500/20 to-rose-500/0', iconBg: 'bg-rose-500/10 border-rose-500/20 text-rose-500', valueCls: 'text-rose-600 dark:text-rose-400', border: 'hover:border-rose-500/40' },
    { gradient: 'from-emerald-500/20 to-emerald-500/0', iconBg: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500', valueCls: 'text-emerald-600 dark:text-emerald-400', border: 'hover:border-emerald-500/40' },
    { gradient: 'from-amber-500/20 to-amber-500/0', iconBg: 'bg-amber-500/10 border-amber-500/20 text-amber-500', valueCls: 'text-amber-600 dark:text-amber-400', border: 'hover:border-amber-500/40' },
]

export function InsightCards({ stats, templatesCount, viewsCount }: {
    stats: StatsType; templatesCount: number; viewsCount: number
}) {
    const cards = [
        { label: 'Context Views', sublabel: 'Active perspectives', value: viewsCount, icon: Monitor },
        { label: 'Model Templates', sublabel: 'Ready to deploy', value: templatesCount, icon: LayoutTemplate },
        { label: 'Data Sources', sublabel: 'Connected pipelines', value: stats.totalDataSources, icon: Network },
        { label: 'Tracked Entities', sublabel: 'Nodes in all graphs', value: new Intl.NumberFormat().format(stats.totalEntities), icon: Component },
    ]
    return (
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 px-4 md:px-0 mb-14">
            {cards.map((c, i) => {
                const t = CARD_THEMES[i]
                return (
                    <motion.div key={c.label}
                        initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.05 + i * 0.08, duration: 0.55, ease: 'easeOut' }}
                        className={cn('relative glass-panel rounded-2xl border border-glass-border p-5 cursor-pointer overflow-hidden group hover:-translate-y-1 hover:shadow-xl transition-all duration-300', t.border)}
                    >
                        <div className={cn('absolute inset-0 bg-gradient-to-br opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none', t.gradient)} />
                        <div className="relative z-10 flex flex-col h-full">
                            <div className={cn('w-9 h-9 rounded-xl border flex items-center justify-center mb-4', t.iconBg)}>
                                <c.icon className="w-4 h-4" />
                            </div>
                            <div className="mt-auto">
                                <div className={cn('text-3xl font-black tracking-tight leading-none mb-1', t.valueCls)}>{c.value}</div>
                                <div className="text-sm font-semibold text-ink">{c.label}</div>
                                <div className="text-xs text-ink-muted mt-0.5">{c.sublabel}</div>
                            </div>
                        </div>
                    </motion.div>
                )
            })}
        </div>
    )
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



/** Format large numbers compactly: 263982 → "264k", 1234567 → "1.2M" */
function compactNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
    if (n >= 10_000) return `${Math.round(n / 1_000)}k`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
    return n.toString()
}

// ───────────────────────────────────────────────────────────────────────────────
// Workspace Card — full-size, spacious design
// ───────────────────────────────────────────────────────────────────────────────
const WORKSPACE_PALETTES = [
    { icon: 'text-indigo-500 bg-indigo-500/10 border-indigo-500/20', accent: 'bg-indigo-500', label: 'text-indigo-500', ring: 'hover:border-indigo-500/40', shadow: 'hover:shadow-indigo-500/10' },
    { icon: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20', accent: 'bg-emerald-500', label: 'text-emerald-500', ring: 'hover:border-emerald-500/40', shadow: 'hover:shadow-emerald-500/10' },
    { icon: 'text-violet-500 bg-violet-500/10 border-violet-500/20', accent: 'bg-violet-500', label: 'text-violet-500', ring: 'hover:border-violet-500/40', shadow: 'hover:shadow-violet-500/10' },
    { icon: 'text-rose-500 bg-rose-500/10 border-rose-500/20', accent: 'bg-rose-500', label: 'text-rose-500', ring: 'hover:border-rose-500/40', shadow: 'hover:shadow-rose-500/10' },
    { icon: 'text-amber-500 bg-amber-500/10 border-amber-500/20', accent: 'bg-amber-500', label: 'text-amber-500', ring: 'hover:border-amber-500/40', shadow: 'hover:shadow-amber-500/10' },
]

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
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 + index * 0.09, duration: 0.55, ease: 'easeOut' }}
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
                            transition={{ duration: 0.3, ease: 'easeInOut' }}
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
    const schemaViews = useSchemaStore(s => s.schema?.views ?? [])
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


// ───────────────────────────────────────────────────────────────────────────────
// Views Grid — fix: clicking opens the specific view
// ───────────────────────────────────────────────────────────────────────────────
const LAYOUT_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
    graph: Network, tree: GitBranch, hierarchy: Layers,
    'layered-lineage': BarChart3, reference: Eye,
}
const LAYOUT_COLORS: Record<string, string> = {
    graph: 'text-indigo-500 bg-indigo-500/10 border-indigo-500/20',
    tree: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
    hierarchy: 'text-violet-500 bg-violet-500/10 border-violet-500/20',
    'layered-lineage': 'text-rose-500 bg-rose-500/10 border-rose-500/20',
    reference: 'text-amber-500 bg-amber-500/10 border-amber-500/20',
}

export function ViewGrid({ title, subtitle, views, icon: Icon, emptyMessage = 'No items found' }: {
    title: string; subtitle?: string; views: ViewConfiguration[]
    icon: React.ComponentType<{ className?: string }>; emptyMessage?: string
}) {
    const openView = useOpenView()  // ← FIX: directly calls setActiveView + navigate
    const setActiveTab = useNavigationStore(s => s.setActiveTab)
    const activeViewId = useSchemaStore(s => s.activeViewId)

    return (
        <section className="mb-16 px-4 md:px-0">
            <div className="flex items-end justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border">
                        <Icon className="w-4 h-4 text-ink-secondary" />
                    </div>
                    <div>
                        <h2 className="text-xl font-bold text-ink tracking-tight">{title}</h2>
                        {subtitle && <p className="text-xs text-ink-muted mt-0.5">{subtitle}</p>}
                    </div>
                </div>
                <button onClick={() => setActiveTab('explore')} className="text-sm font-medium text-ink-muted hover:text-ink flex items-center gap-1 transition-colors">
                    All views <ChevronRight className="w-4 h-4" />
                </button>
            </div>

            {views.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-14 rounded-3xl border-2 border-dashed border-glass-border">
                    <div className="w-12 h-12 rounded-2xl bg-black/5 dark:bg-white/5 border border-glass-border flex items-center justify-center mb-3">
                        <Icon className="w-6 h-6 text-ink-muted/30" />
                    </div>
                    <h3 className="text-sm font-semibold text-ink mb-1">No views yet</h3>
                    <p className="text-sm text-ink-muted text-center max-w-xs">{emptyMessage}</p>
                    <button onClick={() => setActiveTab('explore')} className="mt-4 flex items-center gap-2 px-4 py-2 rounded-xl bg-accent-business/10 border border-accent-business/20 text-accent-business text-sm font-semibold hover:bg-accent-business/20 transition-colors">
                        <Sparkles className="w-4 h-4" /> Explore canvas
                    </button>
                </div>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    {views.map((v, i) => {
                        const layoutType = v.layout?.type ?? 'graph'
                        const LayoutIcon = LAYOUT_ICONS[layoutType] ?? Eye
                        const colorCls = LAYOUT_COLORS[layoutType] ?? 'text-ink-secondary bg-black/5 border-glass-border'
                        const isCurrentView = v.id === activeViewId

                        return (
                            <motion.div
                                key={v.id}
                                initial={{ opacity: 0, y: 16 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: i * 0.06, duration: 0.4 }}
                                onClick={() => openView(v.id)}  // ← FIX: opens THIS specific view
                                className={cn(
                                    'group relative glass-panel rounded-2xl border transition-all cursor-pointer overflow-hidden hover:-translate-y-0.5 hover:shadow-xl flex flex-col min-h-[150px]',
                                    isCurrentView
                                        ? 'border-accent-lineage/50 shadow-lg shadow-accent-lineage/10'
                                        : 'border-glass-border hover:border-accent-lineage/40'
                                )}
                            >
                                {isCurrentView && (
                                    <div className="absolute top-3 right-3 w-2 h-2 rounded-full bg-accent-lineage shadow-[0_0_6px] shadow-accent-lineage animate-pulse" />
                                )}
                                <div className="absolute inset-0 bg-gradient-to-br from-accent-lineage/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
                                <div className="relative p-5 flex flex-col flex-1 justify-between">
                                    <div>
                                        <div className={cn('inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[10px] font-bold uppercase tracking-wider mb-3', colorCls)}>
                                            <LayoutIcon className="w-3 h-3" />
                                            {layoutType}
                                        </div>
                                        <h4 className="font-bold text-base text-ink group-hover:text-accent-lineage transition-colors line-clamp-1 mb-1">{v.name}</h4>
                                        <p className="text-xs text-ink-muted line-clamp-2">{v.description || 'Context view for data exploration'}</p>
                                    </div>
                                    <div className="flex items-center justify-between mt-4 pt-3 border-t border-glass-border/50">
                                        <div className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                                            <Clock className="w-3 h-3" />
                                            <span>{isCurrentView ? 'Current view' : 'Active'}</span>
                                        </div>
                                        <div className="flex items-center gap-1 text-[11px] font-semibold text-ink-muted/0 group-hover:text-accent-lineage transition-all">
                                            Open <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                                        </div>
                                    </div>
                                </div>
                            </motion.div>
                        )
                    })}
                </div>
            )}
        </section>
    )
}

// ───────────────────────────────────────────────────────────────────────────────
// Blueprint / Template Grid
// ───────────────────────────────────────────────────────────────────────────────
const TEMPLATE_CATEGORIES = ['All', 'Data Mesh', 'Governance', 'Lineage', 'Reference']

export function BlueprintGrid({ title, subtitle, items, icon: Icon }: {
    title: string; subtitle?: string
    items: (TemplateBrief | BlueprintBrief)[]
    icon: React.ComponentType<{ className?: string }>
}) {
    const [activeCategory, setActiveCategory] = useState('All')

    if (items.length === 0) {
        return (
            <section className="mb-16 px-4 md:px-0">
                <div className="flex items-end justify-between mb-6">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border">
                            <Icon className="w-4 h-4 text-ink-secondary" />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-ink tracking-tight">{title}</h2>
                            {subtitle && <p className="text-xs text-ink-muted mt-0.5">{subtitle}</p>}
                        </div>
                    </div>
                </div>
                <div className="flex flex-col items-center justify-center p-14 rounded-3xl border-2 border-dashed border-glass-border">
                    <div className="w-12 h-12 rounded-2xl border border-glass-border bg-black/5 dark:bg-white/5 flex items-center justify-center mb-3">
                        <Icon className="w-6 h-6 text-ink-muted/30" />
                    </div>
                    <h3 className="text-sm font-semibold text-ink mb-1">Library is empty</h3>
                    <p className="text-sm text-ink-muted text-center max-w-xs">No templates yet. Create your first context model template to get started.</p>
                </div>
            </section>
        )
    }

    return (
        <section className="mb-16 px-4 md:px-0">
            <div className="flex items-end justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-accent-business/10 border border-accent-business/20">
                        <Icon className="w-4 h-4 text-accent-business" />
                    </div>
                    <div>
                        <h2 className="text-xl font-bold text-ink tracking-tight">{title}</h2>
                        {subtitle && <p className="text-xs text-ink-muted mt-0.5">{subtitle}</p>}
                    </div>
                </div>
                <button className="text-sm font-medium text-ink-muted hover:text-ink flex items-center gap-1 transition-colors">Browse all <ChevronRight className="w-4 h-4" /></button>
            </div>

            <div className="flex items-center gap-2 mb-5 overflow-x-auto pb-1">
                {TEMPLATE_CATEGORIES.map(c => (
                    <button key={c} onClick={() => setActiveCategory(c)}
                        className={cn('px-3.5 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap transition-all shrink-0',
                            activeCategory === c ? 'bg-accent-business text-white shadow-lg shadow-accent-business/20' : 'glass-panel border border-glass-border text-ink-muted hover:text-ink'
                        )}>{c}</button>
                ))}
            </div>

            {/* Featured */}
            <div className="mb-4">
                <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
                    className="group relative glass-panel rounded-2xl border border-accent-business/20 hover:border-accent-business/40 overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-accent-business/10 cursor-pointer"
                >
                    <div className="absolute inset-0 bg-gradient-to-r from-accent-business/5 to-accent-explore/3 pointer-events-none" />
                    <div className="relative p-5 flex items-center gap-5">
                        <div className="w-12 h-12 rounded-2xl bg-accent-business/10 border border-accent-business/20 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                            <Sparkles className="w-6 h-6 text-accent-business" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                                <span className="text-[10px] font-bold uppercase tracking-widest text-accent-business">⭐ Featured</span>
                            </div>
                            <h4 className="font-bold text-lg text-ink group-hover:text-accent-business transition-colors mb-0.5 leading-tight">{items[0].name}</h4>
                            <p className="text-sm text-ink-muted line-clamp-1">{items[0].description || 'Ready-to-deploy semantic context model.'}</p>
                        </div>
                        <div className="shrink-0 flex items-center gap-2">
                            {'version' in items[0] && (
                                <span className="text-xs font-semibold text-ink-muted border border-glass-border rounded-lg px-2 py-1">v{items[0].version || 1}</span>
                            )}
                            <button className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-accent-business text-white font-semibold text-sm hover:bg-accent-business-hover transition-colors shadow-md shadow-accent-business/20">
                                Deploy <ArrowRight className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    </div>
                </motion.div>
            </div>

            {items.length > 1 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {items.slice(1).map((item, i) => (
                        <motion.div key={item.id}
                            initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
                            className="group glass-panel rounded-2xl border border-glass-border hover:border-accent-business/40 hover:shadow-lg hover:-translate-y-0.5 transition-all cursor-pointer p-4 flex items-start gap-3.5"
                        >
                            <div className="w-10 h-10 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border flex items-center justify-center shrink-0 group-hover:bg-accent-business/10 group-hover:border-accent-business/20 transition-all">
                                {'version' in item ? (
                                    <Package className="w-5 h-5 text-ink-muted group-hover:text-accent-business transition-colors" />
                                ) : (
                                    <BookOpen className="w-5 h-5 text-ink-muted group-hover:text-accent-business transition-colors" />
                                )}
                            </div>
                            <div className="flex-1 min-w-0 pt-0.5">
                                <h4 className="font-semibold text-sm text-ink group-hover:text-accent-business transition-colors truncate mb-1">{item.name}</h4>
                                <p className="text-xs text-ink-muted line-clamp-2">{item.description || 'Semantic model template'}</p>
                                <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-glass-border/40">
                                    <span className="text-[10px] uppercase font-bold tracking-wider text-ink-muted">
                                        {'version' in item ? `v${item.version || 1}` : 'Template'}
                                    </span>
                                    <ArrowRight className="w-3.5 h-3.5 text-ink-muted/0 group-hover:text-accent-business transition-all group-hover:translate-x-0.5" />
                                </div>
                            </div>
                        </motion.div>
                    ))}
                </div>
            )}
        </section>
    )
}
