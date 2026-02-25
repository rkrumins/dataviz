import { useRef, useState } from 'react'
import { DashboardStats as StatsType, TemplateBrief, BlueprintBrief, DataSourceStats } from '@/hooks/useDashboardData'
import { type WorkspaceResponse } from '@/services/workspaceService'
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
    Activity,
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
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { type ViewConfiguration } from '@/types/schema'

// ───────────────────────────────────────────────────────────────────────────────
// Hero Section
// ───────────────────────────────────────────────────────────────────────────────
const QUICK_SUGGESTIONS = [
    { icon: TrendingUp, label: 'Sales Pipeline', category: 'Model' },
    { icon: Globe, label: 'Customer 360', category: 'View' },
    { icon: Network, label: 'Data Lineage', category: 'Explore' },
    { icon: Star, label: 'Featured Templates', category: 'Library' },
]

export function DashboardHero() {
    const [focused, setFocused] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)

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
                    Search across all your workspaces, models, views, and data sources in one place.
                </p>

                <div className={cn('relative group transition-all duration-500', focused ? 'scale-[1.02]' : 'scale-100')}>
                    <div className={cn(
                        'absolute -inset-1 rounded-3xl blur-md transition-opacity duration-700',
                        focused
                            ? 'opacity-100 bg-gradient-to-r from-accent-business/40 via-accent-explore/30 to-accent-lineage/40'
                            : 'opacity-0 group-hover:opacity-50 bg-gradient-to-r from-accent-business/20 via-accent-explore/15 to-accent-lineage/20'
                    )} />
                    <div className={cn(
                        'relative flex items-center bg-canvas/95 backdrop-blur-2xl rounded-2xl border shadow-2xl transition-all duration-300 overflow-hidden',
                        focused ? 'border-accent-business/60' : 'border-glass-border'
                    )}>
                        <Search className={cn('w-6 h-6 ml-5 shrink-0 transition-colors duration-200', focused ? 'text-accent-business' : 'text-ink-muted')} />
                        <input
                            ref={inputRef}
                            type="text"
                            placeholder="Search workspaces, models, views, data sources…"
                            onFocus={() => setFocused(true)}
                            onBlur={() => setFocused(false)}
                            className="flex-1 bg-transparent border-none py-5 px-4 text-lg text-ink outline-none placeholder:text-ink-muted/40 font-medium"
                        />
                        <div className="mr-4 flex items-center gap-2">
                            <kbd className="hidden sm:flex items-center gap-1 rounded-lg border border-glass-border bg-black/5 dark:bg-white/5 px-2.5 py-1 text-sm font-medium text-ink-muted">
                                <span className="text-base leading-none">⌘</span>K
                            </kbd>
                        </div>
                    </div>
                </div>

                <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                    <span className="text-[11px] font-bold text-ink-muted uppercase tracking-widest mr-1">Jump to:</span>
                    {QUICK_SUGGESTIONS.map((s, i) => (
                        <motion.button
                            key={s.label}
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.4 + i * 0.08, duration: 0.3 }}
                            className="group flex items-center gap-1.5 px-3.5 py-1.5 rounded-full glass-panel border border-glass-border text-sm font-medium text-ink-muted hover:text-accent-business hover:border-accent-business/40 hover:bg-accent-business/5 transition-all"
                        >
                            <s.icon className="w-3.5 h-3.5 group-hover:scale-110 transition-transform" />
                            {s.label}
                            <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted/50 group-hover:text-accent-business/60 transition-colors ml-0.5">{s.category}</span>
                        </motion.button>
                    ))}
                </div>
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
    stats: StatsType
    templatesCount: number
    viewsCount: number
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
                    <motion.div
                        key={c.label}
                        initial={{ opacity: 0, y: 24 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.05 + i * 0.08, duration: 0.55, ease: 'easeOut' }}
                        className={cn(
                            'relative glass-panel rounded-2xl border border-glass-border p-5 cursor-pointer overflow-hidden transition-all duration-300 group hover:-translate-y-1 hover:shadow-xl',
                            t.border
                        )}
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
// Active Environments — World-Class with Real Graph Stats
// ───────────────────────────────────────────────────────────────────────────────
const WORKSPACE_PALETTES = [
    { icon: 'text-indigo-500 bg-indigo-500/10 border-indigo-500/20', accent: 'bg-indigo-500', label: 'text-indigo-500', ring: 'hover:border-indigo-500/40', shadow: 'hover:shadow-indigo-500/10' },
    { icon: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20', accent: 'bg-emerald-500', label: 'text-emerald-500', ring: 'hover:border-emerald-500/40', shadow: 'hover:shadow-emerald-500/10' },
    { icon: 'text-violet-500 bg-violet-500/10 border-violet-500/20', accent: 'bg-violet-500', label: 'text-violet-500', ring: 'hover:border-violet-500/40', shadow: 'hover:shadow-violet-500/10' },
    { icon: 'text-rose-500 bg-rose-500/10 border-rose-500/20', accent: 'bg-rose-500', label: 'text-rose-500', ring: 'hover:border-rose-500/40', shadow: 'hover:shadow-rose-500/10' },
    { icon: 'text-amber-500 bg-amber-500/10 border-amber-500/20', accent: 'bg-amber-500', label: 'text-amber-500', ring: 'hover:border-amber-500/40', shadow: 'hover:shadow-amber-500/10' },
]


function WorkspaceCard({ ws, index, dataSourceStats }: {
    ws: WorkspaceResponse
    index: number
    dataSourceStats: Record<string, DataSourceStats>
}) {
    const [expanded, setExpanded] = useState(false)
    const palette = WORKSPACE_PALETTES[index % WORKSPACE_PALETTES.length]
    const dataSources = ws.dataSources || []
    const dsCount = dataSources.length
    const isOnline = dsCount > 0 && ws.isActive

    // Aggregate stats across all data sources for this workspace
    const totalNodes = dataSources.reduce((acc, ds) => {
        const key = `${ws.id}/${ds.id}`
        return acc + (dataSourceStats[key]?.nodeCount ?? 0)
    }, 0)
    const totalEdges = dataSources.reduce((acc, ds) => {
        const key = `${ws.id}/${ds.id}`
        return acc + (dataSourceStats[key]?.edgeCount ?? 0)
    }, 0)

    return (
        <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 + index * 0.09, duration: 0.55, ease: 'easeOut' }}
            className={cn(
                'group relative flex flex-col glass-panel rounded-3xl border border-glass-border transition-all duration-300 overflow-hidden hover:-translate-y-1 hover:shadow-2xl',
                palette.ring,
                palette.shadow
            )}
        >
            {/* Color top bar */}
            <div className={cn('h-1 w-full transition-all duration-300', palette.accent, 'opacity-50 group-hover:opacity-100')} />

            <div className="p-6 flex flex-col flex-1">
                {/* Header */}
                <div className="flex items-start gap-3.5 mb-6">
                    <div className={cn('w-14 h-14 rounded-2xl border flex items-center justify-center shrink-0 font-bold text-xl group-hover:scale-105 transition-transform duration-300', palette.icon)}>
                        {ws.name.substring(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1 pt-0.5">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                            <h4 className="font-bold text-lg text-ink leading-tight truncate">{ws.name}</h4>
                            {ws.isDefault && (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest bg-accent-business/10 text-accent-business border border-accent-business/20 shrink-0">
                                    Primary
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-1.5">
                            <span className={cn(
                                'w-2 h-2 rounded-full shrink-0',
                                isOnline
                                    ? 'bg-emerald-500 shadow-[0_0_6px_rgba(34,197,94,0.7)] animate-pulse'
                                    : 'bg-slate-400'
                            )} />
                            <span className="text-xs font-medium text-ink-muted">
                                {isOnline ? 'Online · All sources active' : 'Standby'}
                            </span>
                        </div>
                    </div>
                </div>

                {/* Primary stats grid */}
                <div className="grid grid-cols-3 gap-px bg-glass-border rounded-2xl overflow-hidden mb-5">
                    {[
                        { value: dsCount, label: 'Sources', icon: Server },
                        { value: totalNodes, label: 'Entities', icon: CircleDot },
                        { value: totalEdges, label: 'Relations', icon: GitBranch },
                    ].map(s => (
                        <div key={s.label} className="bg-canvas/80 dark:bg-canvas/60 px-4 py-3 flex flex-col gap-1.5">
                            <div className="flex items-center gap-1.5">
                                <s.icon className="w-3 h-3 text-ink-muted shrink-0" />
                                <span className="text-[9px] uppercase font-black tracking-widest text-ink-muted">{s.label}</span>
                            </div>
                            <span className={cn('text-2xl font-black leading-none', s.value > 0 ? palette.label : 'text-ink-muted/40')}>
                                {s.value > 0 ? s.value.toLocaleString() : '—'}
                            </span>
                        </div>
                    ))}
                </div>

                {/* Expandable DS list */}
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
                    {expanded && dataSources.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.3, ease: 'easeInOut' }}
                            className="overflow-hidden mb-3"
                        >
                            <div className="space-y-2 pt-1">
                                {dataSources.map((ds, j) => {
                                    const key = `${ws.id}/${ds.id}`
                                    const dsStats = dataSourceStats[key]
                                    return (
                                        <div
                                            key={ds.id}
                                            className="relative flex items-center gap-3 p-3 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border/50 hover:border-glass-border transition-all overflow-hidden group/ds"
                                        >
                                            {/* Left color indicator */}
                                            <div className={cn('absolute left-0 top-0 bottom-0 w-0.5', palette.accent)} />
                                            <div className={cn('w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 text-sm ml-1.5', palette.icon)}>
                                                <Database className="w-3.5 h-3.5" />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-sm font-semibold text-ink truncate">
                                                        {ds.label || ds.graphName || `Source ${j + 1}`}
                                                    </span>
                                                    {ds.isPrimary && (
                                                        <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-500 border border-emerald-500/20 rounded-full px-1.5 py-0.5 bg-emerald-500/10 shrink-0">
                                                            Primary
                                                        </span>
                                                    )}
                                                </div>
                                                {ds.graphName && (
                                                    <span className="text-xs text-ink-muted/70 font-mono truncate block">{ds.graphName}</span>
                                                )}
                                            </div>
                                            {/* Mini stats */}
                                            {dsStats && (
                                                <div className="flex flex-col gap-0.5 items-end shrink-0 text-right">
                                                    <span className="text-xs font-bold text-ink">{dsStats.nodeCount.toLocaleString()} nodes</span>
                                                    <span className="text-[10px] text-ink-muted">{dsStats.edgeCount.toLocaleString()} edges</span>
                                                </div>
                                            )}
                                        </div>
                                    )
                                })}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* CTA */}
                <button className={cn(
                    'mt-auto flex items-center justify-between w-full px-4 py-2.5 rounded-xl text-sm font-semibold transition-all border group/cta',
                    'bg-transparent border-glass-border/50 hover:border-glass-border',
                    palette.label
                )}>
                    <span>Open workspace</span>
                    <ArrowRight className="w-4 h-4 group-hover/cta:translate-x-0.5 transition-transform" />
                </button>
            </div>
        </motion.div>
    )
}

export function WorkspaceGrid({ workspaces, dataSourceStats }: {
    workspaces: WorkspaceResponse[]
    dataSourceStats: Record<string, DataSourceStats>
}) {
    if (!workspaces || workspaces.length === 0) return null

    const totalSources = workspaces.reduce((acc, w) => acc + (w.dataSources?.length || 0), 0)

    return (
        <section className="mb-20 px-4 md:px-0">
            <div className="flex items-end justify-between mb-8">
                <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-2xl bg-gradient-to-br from-accent-business/20 to-accent-explore/10 border border-accent-business/25">
                        <Globe className="w-5 h-5 text-accent-business" />
                    </div>
                    <div>
                        <h2 className="text-2xl font-bold text-ink tracking-tight">Active Environments</h2>
                        <p className="text-sm text-ink-muted mt-0.5">
                            {workspaces.length} workspace{workspaces.length !== 1 ? 's' : ''} · {totalSources} total data source{totalSources !== 1 ? 's' : ''}
                        </p>
                    </div>
                </div>
                <button className="text-sm font-semibold text-accent-business hover:text-accent-business-hover flex items-center gap-1 transition-colors">
                    Manage <ChevronRight className="w-4 h-4" />
                </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {workspaces.map((ws, i) => (
                    <WorkspaceCard key={ws.id} ws={ws} index={i} dataSourceStats={dataSourceStats} />
                ))}
            </div>
        </section>
    )
}

// ───────────────────────────────────────────────────────────────────────────────
// Jump Back In — Views Grid (World-Class Redesign)
// ───────────────────────────────────────────────────────────────────────────────
const LAYOUT_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
    graph: Network,
    tree: GitBranch,
    hierarchy: Layers,
    'layered-lineage': BarChart3,
    reference: Eye,
    list: Activity,
}

const LAYOUT_COLORS: Record<string, string> = {
    graph: 'text-indigo-500 bg-indigo-500/10 border-indigo-500/20',
    tree: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
    hierarchy: 'text-violet-500 bg-violet-500/10 border-violet-500/20',
    'layered-lineage': 'text-rose-500 bg-rose-500/10 border-rose-500/20',
    reference: 'text-amber-500 bg-amber-500/10 border-amber-500/20',
    list: 'text-teal-500 bg-teal-500/10 border-teal-500/20',
}

export function ViewGrid({ title, subtitle, views, icon: Icon, emptyMessage = 'No items found' }: {
    title: string
    subtitle?: string
    views: ViewConfiguration[]
    icon: React.ComponentType<{ className?: string }>
    emptyMessage?: string
}) {
    return (
        <section className="mb-16 px-4 md:px-0">
            {/* Section header */}
            <div className="flex items-end justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border">
                        <Icon className="w-4.5 h-4.5 text-ink-secondary" />
                    </div>
                    <div>
                        <h2 className="text-xl font-bold text-ink tracking-tight">{title}</h2>
                        {subtitle && <p className="text-xs text-ink-muted mt-0.5">{subtitle}</p>}
                    </div>
                </div>
                <button className="text-sm font-medium text-ink-muted hover:text-ink flex items-center gap-1 transition-colors">
                    See all <ChevronRight className="w-4 h-4" />
                </button>
            </div>

            {views.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-16 rounded-3xl border-2 border-dashed border-glass-border">
                    <div className="w-14 h-14 rounded-2xl bg-black/5 dark:bg-white/5 border border-glass-border flex items-center justify-center mb-4">
                        <Icon className="w-7 h-7 text-ink-muted/30" />
                    </div>
                    <h3 className="text-sm font-semibold text-ink mb-1">Nothing here yet</h3>
                    <p className="text-sm text-ink-muted text-center max-w-xs">{emptyMessage}</p>
                    <button className="mt-4 flex items-center gap-2 px-4 py-2 rounded-xl bg-accent-business/10 border border-accent-business/20 text-accent-business text-sm font-semibold hover:bg-accent-business/20 transition-colors">
                        <Sparkles className="w-4 h-4" /> Explore views
                    </button>
                </div>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    {views.map((v, i) => {
                        const layoutType = v.layout?.type ?? 'graph'
                        const LayoutIcon = LAYOUT_ICONS[layoutType] ?? Eye
                        const colorCls = LAYOUT_COLORS[layoutType] ?? 'text-ink-secondary bg-black/5 border-glass-border'

                        return (
                            <motion.div
                                key={v.id}
                                initial={{ opacity: 0, y: 16 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: i * 0.06, duration: 0.45 }}
                                className="group relative glass-panel rounded-2xl border border-glass-border hover:border-accent-lineage/50 transition-all cursor-pointer overflow-hidden hover:-translate-y-0.5 hover:shadow-xl flex flex-col min-h-[160px]"
                            >
                                {/* Hover glow */}
                                <div className="absolute inset-0 bg-gradient-to-br from-accent-lineage/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

                                <div className="relative p-5 flex flex-col flex-1 justify-between">
                                    <div>
                                        {/* Layout type badge */}
                                        <div className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-bold uppercase tracking-wider mb-3', colorCls)}>
                                            <LayoutIcon className="w-3 h-3" />
                                            {layoutType}
                                        </div>
                                        <h4 className="font-bold text-base text-ink group-hover:text-accent-lineage transition-colors line-clamp-1 mb-1">{v.name}</h4>
                                        <p className="text-xs text-ink-muted line-clamp-2 leading-relaxed">{v.description || 'Custom context view for data exploration'}</p>
                                    </div>

                                    <div className="flex items-center justify-between mt-4 pt-3 border-t border-glass-border/50">
                                        <div className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                                            <Clock className="w-3 h-3" />
                                            <span>Active</span>
                                        </div>
                                        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted/0 group-hover:text-accent-lineage transition-all">
                                            <span>Open</span>
                                            <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
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
// Starter Templates — Blueprint Grid (World-Class Redesign)
// ───────────────────────────────────────────────────────────────────────────────
const TEMPLATE_CATEGORIES = ['All', 'Data Mesh', 'Governance', 'Lineage', 'Reference']

export function BlueprintGrid({
    title,
    subtitle,
    items,
    icon: Icon,
}: {
    title: string
    subtitle?: string
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
                            <Icon className="w-4.5 h-4.5 text-ink-secondary" />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-ink tracking-tight">{title}</h2>
                            {subtitle && <p className="text-xs text-ink-muted mt-0.5">{subtitle}</p>}
                        </div>
                    </div>
                </div>
                <div className="flex flex-col items-center justify-center p-16 rounded-3xl border-2 border-dashed border-glass-border">
                    <div className="w-14 h-14 rounded-2xl bg-black/5 dark:bg-white/5 border border-glass-border flex items-center justify-center mb-4">
                        <Icon className="w-7 h-7 text-ink-muted/30" />
                    </div>
                    <h3 className="text-sm font-semibold text-ink mb-1">Library is empty</h3>
                    <p className="text-sm text-ink-muted text-center max-w-xs">No templates available yet. Create your first context model template to get started.</p>
                </div>
            </section>
        )
    }

    return (
        <section className="mb-16 px-4 md:px-0">
            {/* Section header */}
            <div className="flex items-end justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-accent-business/10 border border-accent-business/20">
                        <Icon className="w-4.5 h-4.5 text-accent-business" />
                    </div>
                    <div>
                        <h2 className="text-xl font-bold text-ink tracking-tight">{title}</h2>
                        {subtitle && <p className="text-xs text-ink-muted mt-0.5">{subtitle}</p>}
                    </div>
                </div>
                <button className="text-sm font-medium text-ink-muted hover:text-ink flex items-center gap-1 transition-colors">
                    Browse all <ChevronRight className="w-4 h-4" />
                </button>
            </div>

            {/* Category filter pills */}
            <div className="flex items-center gap-2 mb-5 overflow-x-auto scrollbar-hide pb-1">
                {TEMPLATE_CATEGORIES.map(cat => (
                    <button
                        key={cat}
                        onClick={() => setActiveCategory(cat)}
                        className={cn(
                            'px-3.5 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap transition-all shrink-0',
                            activeCategory === cat
                                ? 'bg-accent-business text-white shadow-lg shadow-accent-business/20'
                                : 'glass-panel border border-glass-border text-ink-muted hover:text-ink hover:border-glass-border-hover'
                        )}
                    >
                        {cat}
                    </button>
                ))}
            </div>

            {/* Featured template — first item highlight */}
            {items.length > 0 && (
                <div className="mb-4">
                    <motion.div
                        initial={{ opacity: 0, y: 16 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.5 }}
                        className="group relative glass-panel rounded-3xl border border-accent-business/20 hover:border-accent-business/40 overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-2xl hover:shadow-accent-business/10 cursor-pointer"
                    >
                        {/* Subtle gradient bg */}
                        <div className="absolute inset-0 bg-gradient-to-br from-accent-business/5 via-transparent to-accent-explore/5 pointer-events-none" />
                        <div className="relative p-6 flex items-center gap-6">
                            <div className="w-16 h-16 rounded-2xl bg-accent-business/10 border border-accent-business/20 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform duration-300">
                                <Sparkles className="w-8 h-8 text-accent-business" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                    <span className="text-[10px] font-bold uppercase tracking-widest text-accent-business">⭐ Featured</span>
                                </div>
                                <h4 className="font-bold text-xl text-ink group-hover:text-accent-business transition-colors mb-1">{items[0].name}</h4>
                                <p className="text-sm text-ink-muted line-clamp-2">{items[0].description || 'A ready-to-deploy semantic context model template.'}</p>
                            </div>
                            <div className="shrink-0 flex items-center gap-3">
                                {'version' in items[0] && (
                                    <span className="text-xs font-semibold text-ink-muted border border-glass-border rounded-lg px-2.5 py-1">v{items[0].version || 1}</span>
                                )}
                                <button className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-accent-business text-white font-semibold text-sm hover:bg-accent-business-hover transition-colors shadow-lg shadow-accent-business/20">
                                    Deploy <ArrowRight className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </div>
            )}

            {/* Rest of templates grid */}
            {items.length > 1 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {items.slice(1).map((item, i) => (
                        <motion.div
                            key={item.id}
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: i * 0.06, duration: 0.4 }}
                            className="group glass-panel rounded-2xl border border-glass-border hover:border-accent-business/40 hover:shadow-lg hover:-translate-y-0.5 transition-all cursor-pointer p-5 flex items-start gap-4"
                        >
                            <div className="w-11 h-11 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border flex items-center justify-center shrink-0 group-hover:bg-accent-business/10 group-hover:border-accent-business/20 transition-all">
                                {'version' in item ? (
                                    <Package className="w-5 h-5 text-ink-muted group-hover:text-accent-business transition-colors" />
                                ) : (
                                    <BookOpen className="w-5 h-5 text-ink-muted group-hover:text-accent-business transition-colors" />
                                )}
                            </div>
                            <div className="flex-1 min-w-0 pt-0.5">
                                <h4 className="font-semibold text-sm text-ink group-hover:text-accent-business transition-colors truncate mb-1">{item.name}</h4>
                                <p className="text-xs text-ink-muted line-clamp-2 leading-relaxed">{item.description || 'Semantic model template'}</p>
                                <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-glass-border/50">
                                    <span className="text-[10px] uppercase font-bold tracking-wider text-ink-muted">
                                        {'version' in item ? `Blueprint v${item.version || 1}` : 'Template'}
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
