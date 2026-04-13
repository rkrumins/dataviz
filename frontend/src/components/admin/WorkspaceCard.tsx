import { Database, FolderOpen, Star, Shield, Trash2, ChevronRight, CircleDot, ArrowRightLeft, Layers } from 'lucide-react'
import { cn } from '@/lib/utils'
import { type WorkspaceResponse } from '@/services/workspaceService'
import { WorkspaceHealthBadge } from './workspace/WorkspaceHealthBadge'
import { Neo4jLogo, FalkorDBLogo, DataHubLogo } from './ProviderLogos'

const WS_PALETTES = [
    { icon: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20', accent: 'border-indigo-500/30', glow: 'shadow-indigo-500/10' },
    { icon: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20', accent: 'border-emerald-500/30', glow: 'shadow-emerald-500/10' },
    { icon: 'bg-violet-500/10 text-violet-500 border-violet-500/20', accent: 'border-violet-500/30', glow: 'shadow-violet-500/10' },
    { icon: 'bg-amber-500/10 text-amber-500 border-amber-500/20', accent: 'border-amber-500/30', glow: 'shadow-amber-500/10' },
    { icon: 'bg-rose-500/10 text-rose-500 border-rose-500/20', accent: 'border-rose-500/30', glow: 'shadow-rose-500/10' },
    { icon: 'bg-cyan-500/10 text-cyan-500 border-cyan-500/20', accent: 'border-cyan-500/30', glow: 'shadow-cyan-500/10' },
]

function compactNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
    return String(n)
}

function ProviderIcon({ type, className }: { type?: string; className?: string }) {
    if (type === 'neo4j') return <Neo4jLogo className={className} />
    if (type === 'falkordb') return <FalkorDBLogo className={className} />
    if (type === 'datahub') return <DataHubLogo className={className} />
    return <FolderOpen className={className} />
}

interface WorkspaceCardProps {
    ws: WorkspaceResponse
    index: number
    stats: { nodes: number; edges: number; types: number }
    healthStatus?: 'healthy' | 'warning' | 'critical' | 'unknown'
    providerType?: string
    onOpen: () => void
    onDelete: () => void
    onSetDefault: () => void
}

export function WorkspaceCard({
    ws,
    index,
    stats,
    healthStatus,
    providerType,
    onOpen,
    onDelete,
    onSetDefault,
}: WorkspaceCardProps) {
    const palette = WS_PALETTES[index % WS_PALETTES.length]

    return (
        <div
            className={cn(
                "group border rounded-xl bg-canvas-elevated cursor-pointer flex flex-col h-full",
                "hover:shadow-lg transition-all duration-200",
                ws.isDefault ? palette.accent : "border-glass-border hover:border-indigo-500/20"
            )}
            onClick={onOpen}
        >
            {/* Header: health + icon + name + default badge */}
            <div className="px-5 pt-5 pb-3">
                <div className="flex items-start gap-3">
                    <div className="relative shrink-0">
                        <div className={cn("w-10 h-10 rounded-xl border flex items-center justify-center", palette.icon)}>
                            <ProviderIcon type={providerType} className="w-5 h-5" />
                        </div>
                        <span className="absolute -top-1 -left-1">
                            <WorkspaceHealthBadge status={healthStatus || 'unknown'} />
                        </span>
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                            <h3 className="text-sm font-bold text-ink truncate">{ws.name}</h3>
                            {ws.isDefault && (
                                <span className="shrink-0 px-1.5 py-0.5 text-[9px] font-bold rounded bg-indigo-500/10 text-indigo-500 border border-indigo-500/20">DEFAULT</span>
                            )}
                        </div>
                        {ws.description && <p className="text-xs text-ink-muted mt-0.5 line-clamp-1">{ws.description}</p>}
                    </div>
                </div>
            </div>

            {/* Stats bar: 4 metrics */}
            <div className="px-5 py-3 border-t border-glass-border/50 flex flex-wrap items-center gap-y-2 gap-x-4">
                <div className="flex items-center gap-1.5 text-xs text-ink-secondary">
                    <Database className="w-3 h-3 text-indigo-500" />
                    <span className="font-semibold">{ws.dataSources?.length || 0}</span>
                    <span className="text-ink-muted">sources</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-ink-secondary">
                    <CircleDot className="w-3 h-3 text-emerald-500" />
                    <span className="font-semibold">{stats.nodes > 0 ? compactNum(stats.nodes) : '\u2014'}</span>
                    <span className="text-ink-muted">nodes</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-ink-secondary">
                    <ArrowRightLeft className="w-3 h-3 text-violet-500" />
                    <span className="font-semibold">{stats.edges > 0 ? compactNum(stats.edges) : '\u2014'}</span>
                    <span className="text-ink-muted">edges</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-ink-secondary">
                    <Layers className="w-3 h-3 text-amber-500" />
                    <span className="font-semibold">{stats.types > 0 ? stats.types : '\u2014'}</span>
                    <span className="text-ink-muted">types</span>
                </div>
            </div>

            {/* Data source pills + updated timestamp */}
            <div className="px-5 py-2.5 flex items-center gap-1.5 flex-wrap">
                {ws.dataSources && ws.dataSources.length > 0 && (
                    <>
                        {ws.dataSources.slice(0, 4).map(ds => (
                            <span key={ds.id} className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-lg bg-black/5 dark:bg-white/5 text-ink-secondary border border-glass-border">
                                {ds.isPrimary && <Star className="w-2.5 h-2.5 text-amber-500" />}
                                {ds.label || ds.catalogItemId || ds.id || 'source'}
                            </span>
                        ))}
                        {ws.dataSources.length > 4 && (
                            <span className="px-2 py-1 text-[10px] text-ink-muted">+{ws.dataSources.length - 4}</span>
                        )}
                    </>
                )}
                {ws.updatedAt && (
                    <span className="text-[10px] text-ink-muted ml-auto">
                        Updated {new Date(ws.updatedAt).toLocaleDateString()}
                    </span>
                )}
            </div>

            {/* Action footer (hover reveal) */}
            <div className="px-5 py-3 border-t border-glass-border flex items-center justify-between opacity-0 group-hover:opacity-100 transition-opacity mt-auto">
                <div>
                    {!ws.isDefault && (
                        <button onClick={(e) => { e.stopPropagation(); onSetDefault() }} className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded-lg text-ink-muted hover:text-indigo-500 hover:bg-indigo-500/10 transition-colors">
                            <Shield className="w-3 h-3" /> Set Default
                        </button>
                    )}
                </div>
                <div className="flex items-center gap-1.5">
                    <button onClick={(e) => { e.stopPropagation(); onDelete() }} className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded-lg text-red-500 hover:bg-red-500/10 transition-colors">
                        <Trash2 className="w-3 h-3" /> Delete
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); onOpen() }} className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded-lg text-indigo-500 hover:bg-indigo-500/10 transition-colors">
                        Open <ChevronRight className="w-3 h-3" />
                    </button>
                </div>
            </div>
        </div>
    )
}
