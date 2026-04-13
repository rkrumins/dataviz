import { useState } from 'react'
import { Shield, Trash2, ChevronRight, ChevronDown, ChevronUp, FolderOpen, CircleDot, ArrowRightLeft, GitBranch, Eye, Layers, Star, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { type WorkspaceResponse } from '@/services/workspaceService'
import { WorkspaceHealthBadge } from './workspace/WorkspaceHealthBadge'
import { getProviderLogo } from './ProviderLogos'

// ── Types ────────────────────────────────────────────────────────────

export interface WsDataSourceProviderInfo {
    dsId: string
    dsLabel?: string
    isPrimary: boolean
    providerType: string
    providerName: string
    sourceIdentifier?: string
    aggregationStatus: string
    ontologyName?: string
    /** Actual entity type names from the ontology — used for deduplication across DS */
    entityTypeNames: string[]
    /** Actual relationship type names from the ontology — used for deduplication across DS */
    relationshipTypeNames: string[]
}

/** Pre-computed, deduplicated workspace-level summary (computed in parent). */
export interface WorkspaceSchemaSummary {
    uniqueEntityTypes: number
    uniqueRelationshipTypes: number
    ontologyNames: string[]
    providerGroups: { providerType: string; providerName: string; dsCount: number }[]
    viewCount: number
}

interface WorkspaceCardProps {
    ws: WorkspaceResponse
    index: number
    stats: { nodes: number; edges: number; types: number }
    healthStatus?: 'healthy' | 'warning' | 'critical' | 'unknown'
    dsProviders: WsDataSourceProviderInfo[]
    schemaSummary: WorkspaceSchemaSummary
    onOpen: () => void
    onDelete: () => void
    onSetDefault: () => void
}

// ── Helpers ──────────────────────────────────────────────────────────

function compactNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
    return n.toLocaleString()
}

const GRADIENT_ACCENTS = [
    'from-indigo-500 to-violet-500',
    'from-emerald-500 to-teal-500',
    'from-violet-500 to-fuchsia-500',
    'from-amber-500 to-orange-500',
    'from-rose-500 to-pink-500',
    'from-cyan-500 to-blue-500',
]

// ── Component ────────────────────────────────────────────────────────

export function WorkspaceCard({
    ws,
    index,
    stats,
    healthStatus,
    dsProviders,
    schemaSummary,
    onOpen,
    onDelete,
    onSetDefault,
}: WorkspaceCardProps) {
    const [showSources, setShowSources] = useState(false)
    const gradient = GRADIENT_ACCENTS[index % GRADIENT_ACCENTS.length]
    const { uniqueEntityTypes, uniqueRelationshipTypes, ontologyNames, providerGroups, viewCount } = schemaSummary

    const AGG_META: Record<string, { dot: string; label: string }> = {
        ready:   { dot: 'bg-emerald-400', label: 'Ready' },
        running: { dot: 'bg-indigo-400 animate-pulse', label: 'Running' },
        pending: { dot: 'bg-amber-400 animate-pulse', label: 'Pending' },
        failed:  { dot: 'bg-red-400', label: 'Failed' },
        skipped: { dot: 'bg-gray-400', label: 'Skipped' },
        none:    { dot: 'bg-gray-300 dark:bg-gray-600', label: 'New' },
    }

    return (
        <div
            className={cn(
                "group border rounded-xl bg-canvas-elevated cursor-pointer flex flex-col h-full overflow-hidden",
                "hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200",
                ws.isDefault ? "border-indigo-500/30 ring-1 ring-indigo-500/10" : "border-glass-border hover:border-indigo-500/20"
            )}
            onClick={onOpen}
        >
            {/* ── Gradient accent ── */}
            <div className={cn("h-1 w-full bg-gradient-to-r", gradient)} />

            {/* ── Identity ── */}
            <div className="px-5 pt-4 pb-3">
                <div className="flex items-start gap-3">
                    <div className="relative shrink-0">
                        <div className="w-11 h-11 rounded-xl border border-glass-border flex items-center justify-center bg-gradient-to-br from-black/[0.02] to-black/[0.05] dark:from-white/[0.02] dark:to-white/[0.05]">
                            <FolderOpen className="w-5 h-5 text-ink-muted" />
                        </div>
                        <span className="absolute -top-1 -left-1">
                            <WorkspaceHealthBadge status={healthStatus || 'unknown'} />
                        </span>
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                            <h3 className="text-sm font-bold text-ink truncate">{ws.name}</h3>
                            {ws.isDefault && (
                                <span className="shrink-0 px-1.5 py-0.5 text-[9px] font-bold rounded bg-indigo-500/10 text-indigo-500 border border-indigo-500/20">DEFAULT</span>
                            )}
                        </div>
                        {ws.description ? (
                            <p className="text-xs text-ink-muted line-clamp-2">{ws.description}</p>
                        ) : (
                            <p className="text-xs text-ink-muted/40 italic">No description</p>
                        )}
                    </div>
                    <ChevronRight className="w-4 h-4 text-ink-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-1" />
                </div>
            </div>

            {/* ── At a Glance — stats grid ── */}
            <div className="mx-5 mb-3 grid grid-cols-4 gap-px rounded-lg overflow-hidden border border-glass-border bg-glass-border">
                {[
                    { value: dsProviders.length, label: 'Sources', icon: CircleDot, color: 'text-indigo-500' },
                    { value: stats.nodes > 0 ? compactNum(stats.nodes) : '\u2014', label: 'Nodes', icon: CircleDot, color: 'text-emerald-500' },
                    { value: stats.edges > 0 ? compactNum(stats.edges) : '\u2014', label: 'Edges', icon: ArrowRightLeft, color: 'text-violet-500' },
                    { value: viewCount > 0 ? viewCount : '\u2014', label: 'Views', icon: Eye, color: 'text-cyan-500' },
                ].map(s => (
                    <div key={s.label} className="bg-canvas-elevated p-2 text-center">
                        <div className="text-sm font-bold text-ink">{s.value}</div>
                        <div className="text-[8px] text-ink-muted uppercase tracking-wider">{s.label}</div>
                    </div>
                ))}
            </div>

            {/* ── Data Sources preview ── */}
            <div className="mx-5 mb-3 rounded-lg border border-glass-border overflow-hidden">
                {/* Header — always visible */}
                <button
                    onClick={(e) => { e.stopPropagation(); setShowSources(s => !s) }}
                    className="w-full px-3 py-2 bg-black/[0.02] dark:bg-white/[0.02] flex items-center justify-between hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors"
                >
                    <div className="flex items-center gap-2">
                        <span className="text-[9px] font-bold text-ink-muted uppercase tracking-wider">Data Sources</span>
                        {/* Provider mini-logos inline */}
                        {providerGroups.map(pg => {
                            const Logo = getProviderLogo(pg.providerType)
                            return <Logo key={pg.providerType} className="w-3 h-3" />
                        })}
                    </div>
                    <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-semibold text-ink">{dsProviders.length}</span>
                        {showSources ? <ChevronUp className="w-3 h-3 text-ink-muted" /> : <ChevronDown className="w-3 h-3 text-ink-muted" />}
                    </div>
                </button>

                {/* Expandable source list */}
                {showSources && (
                    <div className="divide-y divide-glass-border/50 animate-in slide-in-from-top-1 fade-in duration-150">
                        {dsProviders.length > 0 ? dsProviders.slice(0, 3).map(dsp => {
                            const Logo = getProviderLogo(dsp.providerType)
                            const agg = AGG_META[dsp.aggregationStatus] || AGG_META.none
                            return (
                                <div key={dsp.dsId} className="flex items-center gap-2.5 px-3 py-2">
                                    <div className="w-6 h-6 rounded-md border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] flex items-center justify-center shrink-0">
                                        <Logo className="w-3.5 h-3.5" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-1.5">
                                            <span className="text-[11px] font-semibold text-ink truncate">
                                                {dsp.dsLabel || dsp.sourceIdentifier || 'Unnamed'}
                                            </span>
                                            {dsp.isPrimary && <Star className="w-2.5 h-2.5 text-amber-500 shrink-0" />}
                                        </div>
                                        <div className="flex items-center gap-2 text-[9px] text-ink-muted">
                                            <span>{dsp.providerName}</span>
                                            {dsp.ontologyName && (
                                                <>
                                                    <span className="text-ink-muted/30">|</span>
                                                    <span className="text-violet-500">{dsp.ontologyName}</span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0" title={agg.label}>
                                        <span className={cn("w-1.5 h-1.5 rounded-full", agg.dot)} />
                                        <span className="text-[9px] text-ink-muted">{agg.label}</span>
                                    </div>
                                </div>
                            )
                        }) : (
                            <div className="px-3 py-3 text-center">
                                <span className="text-[10px] text-ink-muted/50 italic">No sources connected</span>
                            </div>
                        )}
                        {dsProviders.length > 3 && (
                            <div
                                className="px-3 py-2 text-center hover:bg-indigo-500/[0.03] transition-colors cursor-pointer"
                                onClick={(e) => { e.stopPropagation(); onOpen() }}
                            >
                                <span className="text-[10px] text-indigo-500 font-semibold flex items-center justify-center gap-1">
                                    View all {dsProviders.length} sources <ExternalLink className="w-3 h-3" />
                                </span>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* ── Schema — ontology-governed types ── */}
            {(uniqueEntityTypes > 0 || uniqueRelationshipTypes > 0 || ontologyNames.length > 0) && (
                <div className="mx-5 mb-3 p-2.5 rounded-lg bg-violet-500/[0.03] dark:bg-violet-500/[0.05] border border-violet-500/10">
                    <div className="flex items-center gap-3 text-[11px]">
                        <Layers className="w-3.5 h-3.5 text-violet-500 shrink-0" />
                        {uniqueEntityTypes > 0 && (
                            <span className="text-ink-muted">
                                <span className="font-semibold text-ink">{uniqueEntityTypes}</span> entity type{uniqueEntityTypes !== 1 ? 's' : ''}
                            </span>
                        )}
                        {uniqueRelationshipTypes > 0 && (
                            <span className="text-ink-muted">
                                <span className="font-semibold text-ink">{uniqueRelationshipTypes}</span> rel. type{uniqueRelationshipTypes !== 1 ? 's' : ''}
                            </span>
                        )}
                    </div>
                    {ontologyNames.length > 0 && (
                        <div className="flex items-center gap-1.5 mt-1.5 ml-6">
                            <GitBranch className="w-3 h-3 text-violet-400 shrink-0" />
                            {ontologyNames.map(name => (
                                <span key={name} className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-violet-500/10 text-violet-600 dark:text-violet-400 truncate max-w-[130px]">
                                    {name}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* ── Footer ── */}
            <div className="px-5 py-2.5 border-t border-glass-border flex items-center justify-between mt-auto">
                <span className="text-[10px] text-ink-muted">
                    Updated {new Date(ws.updatedAt).toLocaleDateString()}
                </span>
                <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    {!ws.isDefault && (
                        <button onClick={(e) => { e.stopPropagation(); onSetDefault() }} className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-lg text-ink-muted hover:text-indigo-500 hover:bg-indigo-500/10 transition-colors">
                            <Shield className="w-3 h-3" /> Default
                        </button>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); onDelete() }} className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-lg text-red-500/70 hover:text-red-500 hover:bg-red-500/10 transition-colors">
                        <Trash2 className="w-3 h-3" />
                    </button>
                </div>
            </div>
        </div>
    )
}
