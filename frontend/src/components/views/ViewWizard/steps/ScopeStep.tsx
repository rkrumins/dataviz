/**
 * ScopeStep — Step 0 of the View Wizard (create mode only).
 *
 * Two-panel guided data source picker with inline metrics and status.
 * Designed for business users: traffic-light indicators, visual cards,
 * smart defaults, and non-blocking warnings.
 *
 * Accepts `availableWorkspaces` as a prop so future RBAC filtering
 * only requires changing the data source, not this component.
 */

import { useState, useMemo, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { useFeature } from '@/store/features'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Database,
    Search,
    Star,
    CircleDot,
    ArrowRightLeft,
    Layers,
    Check,
    AlertTriangle,
    Loader2,
    GitBranch,
    Clock,
    ShieldCheck,
    ShieldAlert,
    Inbox,
    ExternalLink,
    Server,
    ArrowUpDown,
    ChevronDown,
    X,
    Sparkles,
    WifiOff,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { useProviderHealth, PROVIDER_HEALTH_META } from '@/store/providerHealthModel'
import type { WorkspaceResponse, DataSourceResponse } from '@/services/workspaceService'
import type { ProviderType } from '@/services/providerService'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { SchemaAvailability } from '@/hooks/useWizardScope'
import { useDataSourceStats, type DataSourceStats } from '@/hooks/useDataSourceStats'
import type { DataSourceProviderInfo } from '@/components/admin/workspace/useWorkspaceDetailData'
import { useDataSourceProviderMap } from '@/hooks/useDataSourceProviderMap'
import { getProviderLogo } from '@/components/admin/ProviderLogos'
import type { ScopeMode } from '../ViewWizard'
import type { ProviderScopeOption } from '../useBlankScopeOptions'

// ─── Types ─────────────────────────────────────────────────────────

export interface ScopeStepProps {
    availableWorkspaces: WorkspaceResponse[]
    /** Schema availability for the currently selected data source (authoritative). */
    schemaAvailability: SchemaAvailability
    selectedWorkspaceId: string | null
    selectedDataSourceId: string | null
    activeWorkspaceId: string | null
    onSelectWorkspace: (wsId: string) => void
    onSelectDataSource: (dsId: string) => void

    // ── Blank-model mode ──────────────────────────────────────────
    scopeMode: ScopeMode
    onScopeModeChange: (mode: ScopeMode) => void
    /** Providers (all types) a blank model can be provisioned on, enriched with counts. */
    providers: ProviderScopeOption[]
    /** Published semantic layers a blank model can be seeded from (pre-filtered). */
    ontologies: OntologyDefinitionResponse[]
    blankOptionsLoading: boolean
    selectedProviderId: string | null
    selectedOntologyId: string | null
    onSelectProvider: (id: string) => void
    onSelectOntology: (id: string) => void
}

// ─── Helpers ───────────────────────────────────────────────────────

function compactNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
    return String(n)
}

const AGG_STATUS_META: Record<string, { dot: string; label: string }> = {
    ready:   { dot: 'bg-emerald-500', label: 'Ready' },
    running: { dot: 'bg-amber-500 animate-pulse', label: 'Running' },
    pending: { dot: 'bg-amber-400 animate-pulse', label: 'Pending' },
    failed:  { dot: 'bg-red-500', label: 'Failed' },
    skipped: { dot: 'bg-slate-400', label: 'Skipped' },
    none:    { dot: 'bg-slate-300 dark:bg-slate-600', label: 'Not run' },
}

function isRecommended(ds: DataSourceResponse): boolean {
    return ds.isPrimary && !!ds.ontologyId && ds.aggregationStatus === 'ready'
}

// ─── Data source sort ──────────────────────────────────────────────

type DsSort = 'recommended' | 'az' | 'za' | 'added' | 'updated'

const DS_SORT_OPTIONS: { key: DsSort; label: string }[] = [
    { key: 'recommended', label: 'Recommended' },
    { key: 'az', label: 'Name A → Z' },
    { key: 'za', label: 'Name Z → A' },
    { key: 'added', label: 'Last added' },
    { key: 'updated', label: 'Last updated' },
]

function dsName(ds: DataSourceResponse): string {
    return ds.label || ds.catalogItemId || ''
}

function DataSourceSortControl({
    sort,
    onSortChange,
}: {
    sort: DsSort
    onSortChange: (sort: DsSort) => void
}) {
    const [open, setOpen] = useState(false)
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        function handler(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [])

    useEffect(() => {
        if (!open) return
        function handler(e: KeyboardEvent) {
            if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('keydown', handler)
        return () => document.removeEventListener('keydown', handler)
    }, [open])

    const current = DS_SORT_OPTIONS.find(o => o.key === sort) ?? DS_SORT_OPTIONS[0]

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onClick={() => setOpen(p => !p)}
                className={cn(
                    'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
                    'border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300',
                    'hover:bg-slate-50 dark:hover:bg-slate-800',
                    open && 'ring-1 ring-blue-500/30',
                )}
            >
                <ArrowUpDown className="w-3.5 h-3.5" />
                {current.label}
                <ChevronDown className={cn('w-3 h-3 transition-transform', open && 'rotate-180')} />
            </button>
            {open && (
                <div className="absolute right-0 top-full z-50 mt-1.5 w-44 p-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-xl">
                    {DS_SORT_OPTIONS.map(opt => {
                        const active = sort === opt.key
                        return (
                            <button
                                key={opt.key}
                                type="button"
                                onClick={() => {
                                    onSortChange(opt.key)
                                    setOpen(false)
                                }}
                                className={cn(
                                    'flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs transition-colors',
                                    active
                                        ? 'text-blue-600 dark:text-blue-400 font-semibold bg-blue-500/5'
                                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700/60',
                                )}
                            >
                                <span>{opt.label}</span>
                                {active && <Check className="w-3.5 h-3.5" />}
                            </button>
                        )
                    })}
                </div>
            )}
        </div>
    )
}

function FilterChip({
    active,
    onClick,
    icon,
    label,
}: {
    active: boolean
    onClick: () => void
    icon: ReactNode
    label: string
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                active
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : 'border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800',
            )}
        >
            {icon}
            {label}
        </button>
    )
}

// ─── Workspace List Item ───────────────────────────────────────────

function WorkspaceItem({
    ws,
    isSelected,
    isActive,
    dsCount,
    onClick,
}: {
    ws: WorkspaceResponse
    isSelected: boolean
    isActive: boolean
    dsCount: number
    onClick: () => void
}) {
    return (
        <button
            onClick={onClick}
            className={cn(
                'w-full text-left px-3.5 py-3 rounded-xl transition-colors duration-150',
                'border',
                isSelected
                    ? 'bg-blue-600/8 dark:bg-blue-500/10 border-blue-500/30 shadow-sm'
                    : 'border-transparent hover:bg-slate-100 dark:hover:bg-slate-800/60',
            )}
        >
            <div className="flex items-center gap-2.5">
                <div className={cn(
                    'w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-xs font-bold',
                    isSelected
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400',
                )}>
                    {ws.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                        <span className={cn(
                            'text-sm font-semibold truncate',
                            isSelected ? 'text-blue-700 dark:text-blue-300' : 'text-slate-800 dark:text-slate-200',
                        )}>
                            {ws.name}
                        </span>
                        {ws.isDefault && (
                            <span className="px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 shrink-0">
                                Default
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[11px] text-slate-400 dark:text-slate-500">
                            {dsCount} source{dsCount !== 1 ? 's' : ''}
                        </span>
                        {isActive && (
                            <span className="text-[10px] text-emerald-500 font-medium">active</span>
                        )}
                    </div>
                </div>
                {isSelected && (
                    <Check className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
                )}
            </div>
        </button>
    )
}

// ─── Data Source Card ───────────────────────────────────────────────

function DataSourceCard({
    ds,
    stats,
    statsLoading,
    isSelected,
    providerInfo,
    onClick,
}: {
    ds: DataSourceResponse
    stats?: DataSourceStats
    statsLoading: boolean
    isSelected: boolean
    providerInfo?: DataSourceProviderInfo
    onClick: () => void
}) {
    const aggMeta = AGG_STATUS_META[ds.aggregationStatus] ?? AGG_STATUS_META.none
    const recommended = isRecommended(ds)

    return (
        <button
            onClick={onClick}
            className={cn(
                'relative w-full text-left rounded-xl border-2 p-4 transition-colors duration-150',
                'hover:shadow-md',
                isSelected
                    ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/20 shadow-sm shadow-blue-500/10'
                    : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60 hover:border-slate-300 dark:hover:border-slate-600',
            )}
        >
            {/* Selection checkmark */}
            {isSelected && (
                <div className="absolute top-2.5 right-2.5 w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center">
                    <Check className="w-3 h-3 text-white" />
                </div>
            )}

            {/* Header */}
            <div className="flex items-start gap-3 mb-3">
                <div className={cn(
                    'w-9 h-9 rounded-lg flex items-center justify-center shrink-0',
                    isSelected
                        ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
                        : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400',
                )}>
                    <Database className="w-4 h-4" />
                </div>
                <div className="min-w-0 flex-1 pr-6">
                    <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200 break-words">
                        {ds.label || ds.catalogItemId || 'Unnamed'}
                    </h4>
                    {providerInfo && (
                        <div className="flex items-center gap-1 mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                            <Server className="w-3 h-3 shrink-0 text-sky-500" />
                            <span className="break-words">
                                {providerInfo.providerName}
                                <span className="text-slate-400 dark:text-slate-500"> · {providerInfo.providerType}</span>
                            </span>
                        </div>
                    )}
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        {ds.isPrimary && (
                            <span className="flex items-center gap-0.5 text-[10px] font-bold text-amber-600 dark:text-amber-400">
                                <Star className="w-2.5 h-2.5" />
                                Primary
                            </span>
                        )}
                        {recommended && (
                            <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                                Recommended
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {/* Stats row */}
            <div className="flex items-center gap-3 mb-3">
                {statsLoading && !stats ? (
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Loading stats...
                    </div>
                ) : stats ? (
                    <>
                        <div className="flex items-center gap-1 text-xs">
                            <CircleDot className="w-3 h-3 text-indigo-500" />
                            <span className="font-semibold text-slate-700 dark:text-slate-300">{compactNum(stats.nodeCount)}</span>
                            <span className="text-slate-400">nodes</span>
                        </div>
                        <div className="flex items-center gap-1 text-xs">
                            <ArrowRightLeft className="w-3 h-3 text-violet-500" />
                            <span className="font-semibold text-slate-700 dark:text-slate-300">{compactNum(stats.edgeCount)}</span>
                            <span className="text-slate-400">edges</span>
                        </div>
                        <div className="flex items-center gap-1 text-xs">
                            <Layers className="w-3 h-3 text-emerald-500" />
                            <span className="font-semibold text-slate-700 dark:text-slate-300">{stats.entityTypes.length}</span>
                            <span className="text-slate-400">types</span>
                        </div>
                    </>
                ) : (
                    <span className="text-[11px] text-slate-400">No statistics available</span>
                )}
            </div>

            {/* Status row */}
            <div className="flex items-center gap-3 pt-3 border-t border-slate-100 dark:border-slate-700/50">
                {/* Aggregation status */}
                <div className="flex items-center gap-1.5 text-[11px]">
                    <span className={cn('w-2 h-2 rounded-full shrink-0', aggMeta.dot)} />
                    <span className="text-slate-500 dark:text-slate-400">{aggMeta.label}</span>
                </div>

                {/* Ontology status */}
                <div className="flex items-center gap-1 text-[11px]">
                    {ds.ontologyId ? (
                        <>
                            <ShieldCheck className="w-3 h-3 text-emerald-500" />
                            <span className="text-emerald-600 dark:text-emerald-400">Ontology</span>
                        </>
                    ) : (
                        <>
                            <ShieldAlert className="w-3 h-3 text-amber-500" />
                            <span className="text-amber-600 dark:text-amber-400">No ontology</span>
                        </>
                    )}
                </div>

                {/* Last aggregated */}
                {ds.lastAggregatedAt && (
                    <div className="flex items-center gap-1 text-[11px] text-slate-400 ml-auto">
                        <Clock className="w-3 h-3" />
                        <span>{timeAgo(ds.lastAggregatedAt)}</span>
                    </div>
                )}
            </div>
        </button>
    )
}

// ─── Contextual Banners ────────────────────────────────────────────

function ScopeBanners({ ds, schemaAvailability }: { ds: DataSourceResponse | null; schemaAvailability: SchemaAvailability }) {
    if (!ds) return null

    return (
        <AnimatePresence mode="wait">
            {/* Schema availability — authoritative based on ontology assignment */}
            {schemaAvailability.status === 'ready' && (
                <motion.div
                    key="schema-ok"
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.12 }}
                    className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-emerald-500/20 bg-emerald-500/5"
                >
                    <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    <span className="text-xs text-emerald-700 dark:text-emerald-300 font-medium">
                        Semantic layer assigned — entity types and relationships available
                    </span>
                </motion.div>
            )}

            {!ds.ontologyId && (
                <motion.div
                    key="no-ontology"
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.12 }}
                    className="flex items-start gap-3 px-4 py-3 rounded-xl border border-amber-500/20 bg-amber-500/5"
                >
                    <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                            No semantic layer configured
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                            Views created without an ontology will have limited entity type filtering.
                            You can still proceed.
                        </p>
                        <a
                            href={`/workspaces/${ds.workspaceId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 mt-1.5 text-xs font-medium text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 transition-colors"
                        >
                            Configure Ontology
                            <ExternalLink className="w-3 h-3" />
                        </a>
                    </div>
                </motion.div>
            )}

            {(ds.aggregationStatus === 'running' || ds.aggregationStatus === 'pending') && (
                <motion.div
                    key="aggregating"
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.12 }}
                    className="flex items-start gap-3 px-4 py-3 rounded-xl border border-blue-500/20 bg-blue-500/5"
                >
                    <Loader2 className="w-4 h-4 text-blue-500 mt-0.5 shrink-0 animate-spin" />
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-blue-700 dark:text-blue-300">
                            Aggregation in progress
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            You can proceed — some lineage data may be incomplete until aggregation finishes.
                        </p>
                    </div>
                </motion.div>
            )}

            {ds.aggregationStatus === 'failed' && (
                <motion.div
                    key="failed"
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.12 }}
                    className="flex items-start gap-3 px-4 py-3 rounded-xl border border-red-500/20 bg-red-500/5"
                >
                    <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-red-700 dark:text-red-300">
                            Aggregation failed
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            Lineage data may be incomplete. You can still create a view or retry aggregation from the admin panel.
                        </p>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    )
}

// ─── Empty States ──────────────────────────────────────────────────

function NoWorkspacesState() {
    return (
        <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-4">
                <Inbox className="w-7 h-7 text-slate-300 dark:text-slate-600" />
            </div>
            <p className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">
                No workspaces available
            </p>
            <p className="text-xs text-slate-400 max-w-[260px]">
                Create a workspace with at least one data source to start building views.
            </p>
            <a
                href="/workspaces"
                className="mt-3 text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 transition-colors"
            >
                Go to Workspace Settings
            </a>
        </div>
    )
}

function NoDataSourcesState({ workspaceName }: { workspaceName: string }) {
    return (
        <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-12 h-12 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-3">
                <Database className="w-6 h-6 text-slate-300 dark:text-slate-600" />
            </div>
            <p className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">
                No data sources
            </p>
            <p className="text-xs text-slate-400 max-w-[220px]">
                "{workspaceName}" has no data sources configured yet.
            </p>
        </div>
    )
}

// ─── Blank-model mode ──────────────────────────────────────────────

function ScopeModeToggle({ mode, onChange }: { mode: ScopeMode; onChange: (m: ScopeMode) => void }) {
    const options: { id: ScopeMode; label: string; icon: ReactNode }[] = [
        { id: 'existing', label: 'Use existing data', icon: <Database className="w-4 h-4" /> },
        { id: 'blank', label: 'Start from blank', icon: <Sparkles className="w-4 h-4" /> },
    ]
    return (
        <div className="inline-flex items-center rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 p-1">
            {options.map(opt => {
                const active = mode === opt.id
                return (
                    <button
                        key={opt.id}
                        type="button"
                        onClick={() => onChange(opt.id)}
                        className={cn(
                            'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                            active
                                ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-sm'
                                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200',
                        )}
                    >
                        {opt.icon}
                        {opt.label}
                    </button>
                )
            })}
        </div>
    )
}

// Provider-type visual meta — copied from admin/RegistryConnections so the
// wizard renders the same brand tint/label without importing the admin surface.
const PROVIDER_TYPE_META: Record<string, { label: string; color: string; desc: string }> = {
    falkordb: { label: 'FalkorDB', color: 'text-amber-500 bg-amber-500/10 border-amber-500/20', desc: 'High-performance graph database' },
    neo4j: { label: 'Neo4j', color: 'text-blue-500 bg-blue-500/10 border-blue-500/20', desc: 'The original graph database' },
    datahub: { label: 'DataHub', color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20', desc: 'LinkedIn metadata platform' },
    spanner: { label: 'Google Spanner Graph', color: 'text-sky-500 bg-sky-500/10 border-sky-500/20', desc: 'Globally-distributed property graph on Spanner' },
}
/** Standard types always get a filter pill (disabled when count is 0). */
const PROVIDER_TYPE_ORDER: ProviderType[] = ['falkordb', 'neo4j', 'datahub', 'spanner']

function providerMeta(type: string) {
    return PROVIDER_TYPE_META[type] ?? { label: type, color: 'text-slate-500 bg-slate-500/10 border-slate-500/20', desc: '' }
}

/** Provider registry + semantic layer management routes (used by empty states). */
const CONNECTIONS_ROUTE = '/ingestion?tab=connections'
const SEMANTIC_LAYERS_ROUTE = '/schema'

/** Provider card — brand logo + tint, LIVE health dot, graph counts, and the two
 *  gates that decide whether you can build here: blank-support (FalkorDB only today)
 *  and reachability (a confirmed-offline provider is never selectable — you can't
 *  create data in something that's down). */
function ProviderCard({ option, isSelected, onSelect }: { option: ProviderScopeOption; isSelected: boolean; onSelect: () => void }) {
    const { provider, graphCount, inUseCount, blankSupported } = option
    const meta = providerMeta(provider.providerType)
    const Logo = getProviderLogo(provider.providerType)
    const health = useProviderHealth(provider.id)
    const healthMeta = PROVIDER_HEALTH_META[health.state]
    const isOffline = health.state === 'offline'
    // Both gates must pass to build here. Offline is the hard, universal block; the
    // blank-support gate is the existing "FalkorDB only" limitation.
    const selectable = blankSupported && healthMeta.selectable

    return (
        <button
            type="button"
            onClick={selectable ? onSelect : undefined}
            aria-disabled={!selectable}
            className={cn(
                'relative w-full text-left rounded-xl border-2 p-4 transition-colors duration-150',
                selectable ? 'hover:shadow-md' : 'cursor-default',
                isSelected
                    ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/20 shadow-sm shadow-blue-500/10'
                    : isOffline
                        ? 'border-red-200 dark:border-red-900/40 bg-red-50/30 dark:bg-red-950/10'
                        : selectable
                            ? 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60 hover:border-slate-300 dark:hover:border-slate-600'
                            : 'border-slate-200 dark:border-slate-700 bg-white/60 dark:bg-slate-800/40',
            )}
        >
            {isSelected && (
                <div className="absolute top-2.5 right-2.5 w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center">
                    <Check className="w-3 h-3 text-white" />
                </div>
            )}
            <div className="flex items-start gap-3">
                <div className={cn('w-10 h-10 rounded-xl border flex items-center justify-center shrink-0', meta.color)}>
                    <Logo className="w-5 h-5" />
                </div>
                <div className="min-w-0 flex-1 pr-6">
                    <div className="flex items-center gap-1.5">
                        <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200 truncate">{provider.name}</h4>
                        <span
                            className={cn('w-2 h-2 rounded-full shrink-0', healthMeta.dot)}
                            title={health.error ?? healthMeta.label}
                        />
                    </div>
                    <div className="flex items-center gap-1 mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                        <span>{meta.label}</span>
                        {provider.host && <span className="font-mono text-slate-400 dark:text-slate-500 truncate">· {provider.host}</span>}
                    </div>
                    <div className="mt-1.5 flex items-center gap-2 text-[11px]">
                        <span className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300">
                            <Layers className="w-3 h-3 text-slate-400" />
                            <span className="font-semibold">{graphCount}</span>
                            <span className="text-slate-400">graph{graphCount !== 1 ? 's' : ''}</span>
                        </span>
                        {inUseCount > 0 && <span className="text-slate-400">· {inUseCount} in use</span>}
                    </div>
                    {/* Reachability blocks first (you can't build on a down provider),
                        then the blank-support limitation. */}
                    {isOffline ? (
                        <div className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-red-600 dark:text-red-400">
                            <WifiOff className="w-3 h-3 shrink-0" />
                            <span className="truncate">Offline — can’t create here until it’s reachable</span>
                        </div>
                    ) : !blankSupported ? (
                        <div className="mt-1.5 text-[11px] text-slate-400 dark:text-slate-500 italic">
                            Not yet available for blank models
                        </div>
                    ) : null}
                </div>
            </div>
        </button>
    )
}

/** Ontology card — semantic-layer tile, published badge, type counts, description. */
function OntologyCard({ ontology, isSelected, onSelect }: { ontology: OntologyDefinitionResponse; isSelected: boolean; onSelect: () => void }) {
    const entityCount = Object.keys(ontology.entityTypeDefinitions ?? {}).length
    const relCount = Object.keys(ontology.relationshipTypeDefinitions ?? {}).length
    return (
        <button
            type="button"
            onClick={onSelect}
            className={cn(
                'relative w-full text-left rounded-xl border-2 p-4 transition-colors duration-150 hover:shadow-md',
                isSelected
                    ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/20 shadow-sm shadow-blue-500/10'
                    : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60 hover:border-slate-300 dark:hover:border-slate-600',
            )}
        >
            {isSelected && (
                <div className="absolute top-2.5 right-2.5 w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center">
                    <Check className="w-3 h-3 text-white" />
                </div>
            )}
            <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 text-violet-500 bg-violet-500/10 border-violet-500/20">
                    <Sparkles className="w-5 h-5" />
                </div>
                <div className="min-w-0 flex-1 pr-6">
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200 truncate">{ontology.name}</h4>
                        {ontology.isPublished && (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                                <Check className="w-2.5 h-2.5" /> Published
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-3 mt-1">
                        <div className="flex items-center gap-1 text-xs">
                            <Layers className="w-3 h-3 text-emerald-500" />
                            <span className="font-semibold text-slate-700 dark:text-slate-300">{entityCount}</span>
                            <span className="text-slate-400">entities</span>
                        </div>
                        <div className="flex items-center gap-1 text-xs">
                            <GitBranch className="w-3 h-3 text-violet-500" />
                            <span className="font-semibold text-slate-700 dark:text-slate-300">{relCount}</span>
                            <span className="text-slate-400">relationships</span>
                        </div>
                    </div>
                    {ontology.description && (
                        <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500 line-clamp-2 leading-relaxed">
                            {ontology.description}
                        </p>
                    )}
                </div>
            </div>
        </button>
    )
}

/** Per-type filter pill with a count; disabled when its type has no providers. */
function TypePill({ label, count, active, disabled, onClick }: { label: string; count: number; active: boolean; disabled: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                disabled
                    ? 'opacity-40 cursor-not-allowed border-slate-200 dark:border-slate-700 text-slate-400'
                    : active
                        ? 'border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400'
                        : 'border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800',
            )}
        >
            {label}
            <span className={cn('tabular-nums', active ? 'text-blue-500' : 'text-slate-400')}>{count}</span>
        </button>
    )
}

/** Skeleton grid shown while providers + semantic layers load. */
function PickerSkeleton() {
    return (
        <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="rounded-xl border-2 border-slate-200 dark:border-slate-700 p-4 animate-pulse">
                    <div className="flex items-start gap-3">
                        <div className="w-10 h-10 rounded-xl bg-slate-200 dark:bg-slate-700 shrink-0" />
                        <div className="flex-1 space-y-2 pt-1">
                            <div className="h-3 w-2/3 bg-slate-200 dark:bg-slate-700 rounded" />
                            <div className="h-2 w-1/2 bg-slate-100 dark:bg-slate-800 rounded" />
                            <div className="h-2 w-1/3 bg-slate-100 dark:bg-slate-800 rounded" />
                        </div>
                    </div>
                </div>
            ))}
        </div>
    )
}

function BlankPickerEmpty({ icon, title, hint, href, cta }: { icon: ReactNode; title: string; hint: string; href: string; cta: string }) {
    return (
        <div className="flex flex-col items-center justify-center py-8 text-center rounded-xl border border-dashed border-slate-200 dark:border-slate-700">
            <div className="w-11 h-11 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-3 text-slate-300 dark:text-slate-600">
                {icon}
            </div>
            <p className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">{title}</p>
            <p className="text-xs text-slate-400 max-w-[280px]">{hint}</p>
            <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 mt-2 text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 transition-colors"
            >
                {cta}
                <ExternalLink className="w-3 h-3" />
            </a>
        </div>
    )
}

function BlankScopePickers({
    providers,
    ontologies,
    loading,
    selectedProviderId,
    selectedOntologyId,
    onSelectProvider,
    onSelectOntology,
}: {
    providers: ProviderScopeOption[]
    ontologies: OntologyDefinitionResponse[]
    loading: boolean
    selectedProviderId: string | null
    selectedOntologyId: string | null
    onSelectProvider: (id: string) => void
    onSelectOntology: (id: string) => void
}) {
    const [typeFilter, setTypeFilter] = useState<'all' | string>('all')

    const countsByType = useMemo(() => {
        const counts: Record<string, number> = {}
        for (const o of providers) counts[o.provider.providerType] = (counts[o.provider.providerType] ?? 0) + 1
        return counts
    }, [providers])

    // Standard types first, then any non-standard type that's actually present.
    const pillTypes = useMemo(() => {
        const extras = Object.keys(countsByType).filter(t => !PROVIDER_TYPE_ORDER.includes(t as ProviderType))
        return [...PROVIDER_TYPE_ORDER, ...extras]
    }, [countsByType])

    const visibleProviders = useMemo(
        () => (typeFilter === 'all' ? providers : providers.filter(o => o.provider.providerType === typeFilter)),
        [providers, typeFilter],
    )

    return (
        <div className="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar">
            {/* Provider picker */}
            <section className="space-y-3">
                <div className="flex items-center gap-2">
                    <Server className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">Graph connection</span>
                    <span className="text-xs text-slate-400 ml-auto">{providers.length}</span>
                </div>

                {loading ? (
                    <PickerSkeleton />
                ) : providers.length === 0 ? (
                    <BlankPickerEmpty
                        icon={<Server className="w-6 h-6" />}
                        title="No connections available"
                        hint="Ask an admin to register a graph provider for this workspace."
                        href={CONNECTIONS_ROUTE}
                        cta="Manage connections"
                    />
                ) : (
                    <>
                        <div className="flex flex-wrap items-center gap-1.5">
                            <TypePill label="All" count={providers.length} active={typeFilter === 'all'} disabled={false} onClick={() => setTypeFilter('all')} />
                            {pillTypes.map(t => (
                                <TypePill
                                    key={t}
                                    label={providerMeta(t).label}
                                    count={countsByType[t] ?? 0}
                                    active={typeFilter === t}
                                    disabled={(countsByType[t] ?? 0) === 0}
                                    onClick={() => setTypeFilter(t)}
                                />
                            ))}
                        </div>
                        {visibleProviders.length === 0 ? (
                            <BlankPickerEmpty
                                icon={<Server className="w-6 h-6" />}
                                title={`No ${providerMeta(typeFilter).label} connections`}
                                hint="Register one in the provider registry, or pick another type above."
                                href={CONNECTIONS_ROUTE}
                                cta="Manage connections"
                            />
                        ) : (
                            <div className="grid gap-3 sm:grid-cols-2">
                                {visibleProviders.map(o => (
                                    <ProviderCard
                                        key={o.provider.id}
                                        option={o}
                                        isSelected={o.provider.id === selectedProviderId}
                                        onSelect={() => onSelectProvider(o.provider.id)}
                                    />
                                ))}
                            </div>
                        )}
                    </>
                )}
            </section>

            {/* Ontology picker */}
            <section className="space-y-3">
                <div className="flex items-center gap-2">
                    <Sparkles className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">Published semantic layer</span>
                    <span className="text-xs text-slate-400 ml-auto">{ontologies.length}</span>
                </div>
                {loading ? (
                    <PickerSkeleton />
                ) : ontologies.length === 0 ? (
                    <BlankPickerEmpty
                        icon={<Sparkles className="w-6 h-6" />}
                        title="No published semantic layers"
                        hint="Publish a semantic layer to seed a blank model from it."
                        href={SEMANTIC_LAYERS_ROUTE}
                        cta="Manage semantic layers"
                    />
                ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                        {ontologies.map(o => (
                            <OntologyCard
                                key={o.id}
                                ontology={o}
                                isSelected={o.id === selectedOntologyId}
                                onSelect={() => onSelectOntology(o.id)}
                            />
                        ))}
                    </div>
                )}
            </section>
        </div>
    )
}

// ─── Main Component ────────────────────────────────────────────────

const NO_FILTERS = { primary: false, ontology: false, ready: false }

export function ScopeStep({
    availableWorkspaces,
    schemaAvailability,
    selectedWorkspaceId,
    selectedDataSourceId,
    activeWorkspaceId,
    onSelectWorkspace,
    onSelectDataSource,
    scopeMode,
    onScopeModeChange,
    providers,
    ontologies,
    blankOptionsLoading,
    selectedProviderId,
    selectedOntologyId,
    onSelectProvider,
    onSelectOntology,
}: ScopeStepProps) {
    const isBlank = scopeMode === 'blank'
    // Blank models are versioning-native (authored via drafts/publishes) — the
    // whole mode disappears when the admin turns version control off.
    const blankModeAvailable = useFeature('versioningEnabled')
    useEffect(() => {
        if (!blankModeAvailable && scopeMode === 'blank') onScopeModeChange('existing')
    }, [blankModeAvailable, scopeMode, onScopeModeChange])
    const [wsSearch, setWsSearch] = useState('')
    const [dsSearch, setDsSearch] = useState('')
    const [dsSort, setDsSort] = useState<DsSort>('recommended')
    const [dsFilters, setDsFilters] = useState(NO_FILTERS)

    // Resolves the provider (e.g. falkordb/neo4j) each data source is built on.
    const { resolve: resolveProvider } = useDataSourceProviderMap()

    // Reset data-source search/sort/filters when the workspace changes so
    // filters don't leak across workspaces.
    useEffect(() => {
        setDsSearch('')
        setDsSort('recommended')
        setDsFilters(NO_FILTERS)
    }, [selectedWorkspaceId])

    // Single-workspace fast path: auto-select if only one exists
    const singleWorkspace = availableWorkspaces.length === 1
    useEffect(() => {
        if (singleWorkspace && !selectedWorkspaceId) {
            onSelectWorkspace(availableWorkspaces[0].id)
        }
    }, [singleWorkspace, selectedWorkspaceId, availableWorkspaces, onSelectWorkspace])

    // Selected workspace data
    const selectedWorkspace = useMemo(
        () => availableWorkspaces.find(ws => ws.id === selectedWorkspaceId) ?? null,
        [availableWorkspaces, selectedWorkspaceId],
    )

    const dataSources = useMemo(() => selectedWorkspace?.dataSources ?? [], [selectedWorkspace])

    // Single-data-source fast path: auto-select if only one exists
    useEffect(() => {
        if (dataSources.length === 1 && !selectedDataSourceId) {
            onSelectDataSource(dataSources[0].id)
        }
    }, [dataSources, selectedDataSourceId, onSelectDataSource])

    // Selected data source
    const selectedDs = useMemo(
        () => dataSources.find(ds => ds.id === selectedDataSourceId) ?? null,
        [dataSources, selectedDataSourceId],
    )

    // Filter workspaces by search
    const filteredWorkspaces = useMemo(() => {
        if (!wsSearch.trim()) return availableWorkspaces
        const q = wsSearch.toLowerCase()
        return availableWorkspaces.filter(ws => ws.name.toLowerCase().includes(q))
    }, [availableWorkspaces, wsSearch])

    // Filter + sort the data sources for display.
    const visibleDataSources = useMemo(() => {
        const q = dsSearch.trim().toLowerCase()
        const filtered = dataSources.filter(ds => {
            if (dsFilters.primary && !ds.isPrimary) return false
            if (dsFilters.ontology && !ds.ontologyId) return false
            if (dsFilters.ready && ds.aggregationStatus !== 'ready') return false
            if (q) {
                const prov = resolveProvider(ds.id)
                const haystack = [
                    ds.label,
                    ds.catalogItemId,
                    prov?.providerName,
                    prov?.providerType,
                ].filter(Boolean).join(' ').toLowerCase()
                if (!haystack.includes(q)) return false
            }
            return true
        })

        return filtered.sort((a, b) => {
            switch (dsSort) {
                case 'az':
                    return dsName(a).localeCompare(dsName(b))
                case 'za':
                    return dsName(b).localeCompare(dsName(a))
                case 'added':
                    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
                case 'updated':
                    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
                case 'recommended':
                default: {
                    const aRec = isRecommended(a) ? -2 : a.isPrimary ? -1 : 0
                    const bRec = isRecommended(b) ? -2 : b.isPrimary ? -1 : 0
                    if (aRec !== bRec) return aRec - bRec
                    return dsName(a).localeCompare(dsName(b))
                }
            }
        })
    }, [dataSources, dsSearch, dsSort, dsFilters, resolveProvider])

    // Fetch cached stats only for the visible sources of the selected workspace
    // (not eagerly for every source across every workspace).
    const visibleDsIds = useMemo(() => visibleDataSources.map(ds => ds.id), [visibleDataSources])
    const { statsMap, isLoading: statsLoading } = useDataSourceStats(selectedWorkspaceId, visibleDsIds)

    const hasActiveDsFilter = !!dsSearch.trim() || dsFilters.primary || dsFilters.ontology || dsFilters.ready
    const clearDsFilters = useCallback(() => {
        setDsSearch('')
        setDsFilters(NO_FILTERS)
    }, [])

    const handleSelectWorkspace = useCallback((wsId: string) => {
        onSelectWorkspace(wsId)
        // Clear data source when switching workspace, unless it's the same workspace
        if (wsId !== selectedWorkspaceId) {
            // Parent will handle reset — we just notify
        }
    }, [onSelectWorkspace, selectedWorkspaceId])

    if (availableWorkspaces.length === 0) {
        return <NoWorkspacesState />
    }

    return (
        <div className="space-y-5">
            {/* Intro */}
            <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.12 }}
                className="text-center mb-2"
            >
                <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 text-sm font-medium mb-3">
                    {isBlank ? <Sparkles className="w-4 h-4" /> : <Database className="w-4 h-4" />}
                    {isBlank ? 'Start a blank lineage model' : 'Choose your data source'}
                </div>
                <h3 className="text-2xl font-bold text-slate-900 dark:text-white mb-1.5">
                    Where should this view live?
                </h3>
                <p className="text-slate-500 dark:text-slate-400 text-sm">
                    {isBlank
                        ? 'Pick a workspace, a FalkorDB connection, and a published semantic layer'
                        : 'Select the workspace and data source this view will be built from'}
                </p>
            </motion.div>

            {/* Mode toggle */}
            {blankModeAvailable && (
                <div className="flex justify-center">
                    <ScopeModeToggle mode={scopeMode} onChange={onScopeModeChange} />
                </div>
            )}

            {/* Two-panel layout */}
            <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.12, delay: 0.05 }}
                className={cn(
                    'flex rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden',
                    'bg-white dark:bg-slate-800/40',
                    'min-h-[360px]',
                )}
            >
                {/* Left: Workspace List (hidden for single workspace) */}
                {!singleWorkspace && (
                    <div className="w-[240px] shrink-0 border-r border-slate-200 dark:border-slate-700 flex flex-col">
                        {/* Search */}
                        <div className="p-2.5 border-b border-slate-100 dark:border-slate-700/50">
                            <div className="relative">
                                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                                <input
                                    type="text"
                                    placeholder="Filter workspaces..."
                                    value={wsSearch}
                                    onChange={e => setWsSearch(e.target.value)}
                                    className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 placeholder:text-slate-400 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/30 transition-colors"
                                />
                            </div>
                        </div>

                        {/* Workspace list */}
                        <div className="flex-1 overflow-y-auto p-2 space-y-0.5 custom-scrollbar">
                            {filteredWorkspaces.map(ws => (
                                <WorkspaceItem
                                    key={ws.id}
                                    ws={ws}
                                    isSelected={ws.id === selectedWorkspaceId}
                                    isActive={ws.id === activeWorkspaceId}
                                    dsCount={ws.dataSources?.length ?? 0}
                                    onClick={() => handleSelectWorkspace(ws.id)}
                                />
                            ))}
                            {filteredWorkspaces.length === 0 && (
                                <div className="py-6 text-center text-xs text-slate-400">
                                    No workspaces match "{wsSearch}"
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Right: Data Source Cards, or blank-model pickers */}
                <div className="flex-1 flex flex-col min-w-0">
                    {selectedWorkspace && isBlank ? (
                        <BlankScopePickers
                            providers={providers}
                            ontologies={ontologies}
                            loading={blankOptionsLoading}
                            selectedProviderId={selectedProviderId}
                            selectedOntologyId={selectedOntologyId}
                            onSelectProvider={onSelectProvider}
                            onSelectOntology={onSelectOntology}
                        />
                    ) : selectedWorkspace ? (
                        <>
                            {/* Right header + toolbar */}
                            <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-700/50 space-y-2.5">
                                <div className="flex items-center gap-2">
                                    <GitBranch className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                    <span className="text-xs text-slate-400">Data sources in</span>
                                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 truncate">
                                        {selectedWorkspace.name}
                                    </span>
                                    <span className="text-xs text-slate-400 ml-auto shrink-0">
                                        {visibleDataSources.length === dataSources.length
                                            ? `${dataSources.length} source${dataSources.length !== 1 ? 's' : ''}`
                                            : `${visibleDataSources.length} of ${dataSources.length} sources`}
                                    </span>
                                </div>

                                {dataSources.length > 0 && (
                                    <div className="flex items-center gap-2 flex-wrap">
                                        {/* Search */}
                                        <div className="relative flex-1 min-w-[160px]">
                                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                                            <input
                                                type="text"
                                                placeholder="Search data sources..."
                                                value={dsSearch}
                                                onChange={e => setDsSearch(e.target.value)}
                                                onKeyDown={e => e.stopPropagation()}
                                                className="w-full pl-8 pr-7 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500/40"
                                            />
                                            {dsSearch && (
                                                <button
                                                    type="button"
                                                    onClick={() => setDsSearch('')}
                                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                                                >
                                                    <X className="w-3.5 h-3.5" />
                                                </button>
                                            )}
                                        </div>

                                        {/* Sort */}
                                        <DataSourceSortControl sort={dsSort} onSortChange={setDsSort} />
                                    </div>
                                )}

                                {dataSources.length > 0 && (
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                        <FilterChip
                                            active={dsFilters.primary}
                                            onClick={() => setDsFilters(f => ({ ...f, primary: !f.primary }))}
                                            icon={<Star className="w-3 h-3" />}
                                            label="Primary"
                                        />
                                        <FilterChip
                                            active={dsFilters.ontology}
                                            onClick={() => setDsFilters(f => ({ ...f, ontology: !f.ontology }))}
                                            icon={<ShieldCheck className="w-3 h-3" />}
                                            label="Semantic layer"
                                        />
                                        <FilterChip
                                            active={dsFilters.ready}
                                            onClick={() => setDsFilters(f => ({ ...f, ready: !f.ready }))}
                                            icon={<span className="w-2 h-2 rounded-full bg-emerald-500" />}
                                            label="Ready"
                                        />
                                    </div>
                                )}
                            </div>

                            {/* Data source grid */}
                            {dataSources.length === 0 ? (
                                <NoDataSourcesState workspaceName={selectedWorkspace.name} />
                            ) : visibleDataSources.length > 0 ? (
                                <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                                    <div className={cn(
                                        'grid gap-3',
                                        visibleDataSources.length === 1
                                            ? 'grid-cols-1 max-w-md'
                                            : visibleDataSources.length === 2
                                                ? 'grid-cols-1 sm:grid-cols-2'
                                                : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
                                    )}>
                                        {visibleDataSources.map((ds, i) => (
                                            <motion.div
                                                key={ds.id}
                                                initial={{ opacity: 0, y: 8 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                transition={{ duration: 0.12, delay: Math.min(i * 0.01, 0.05) }}
                                            >
                                                <DataSourceCard
                                                    ds={ds}
                                                    stats={statsMap[`${selectedWorkspaceId}/${ds.id}`]}
                                                    statsLoading={statsLoading}
                                                    isSelected={ds.id === selectedDataSourceId}
                                                    providerInfo={resolveProvider(ds.id)}
                                                    onClick={() => onSelectDataSource(ds.id)}
                                                />
                                            </motion.div>
                                        ))}
                                    </div>
                                </div>
                            ) : (
                                <div className="flex-1 flex items-center justify-center p-6">
                                    <div className="text-center">
                                        <div className="w-12 h-12 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-3">
                                            <Search className="w-6 h-6 text-slate-300 dark:text-slate-600" />
                                        </div>
                                        <p className="text-sm font-medium text-slate-500 dark:text-slate-400 mb-1">
                                            No data sources match your filters
                                        </p>
                                        {hasActiveDsFilter && (
                                            <button
                                                type="button"
                                                onClick={clearDsFilters}
                                                className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                                            >
                                                Clear filters
                                            </button>
                                        )}
                                    </div>
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="flex-1 flex items-center justify-center">
                            <div className="text-center">
                                <div className="w-12 h-12 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-3">
                                    <Database className="w-6 h-6 text-slate-300 dark:text-slate-600" />
                                </div>
                                <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
                                    Select a workspace to see its data sources
                                </p>
                            </div>
                        </div>
                    )}
                </div>
            </motion.div>

            {/* Contextual banners (existing-data mode only) */}
            {!isBlank && <ScopeBanners ds={selectedDs} schemaAvailability={schemaAvailability} />}
        </div>
    )
}

export default ScopeStep
