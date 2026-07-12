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

import { useState, useMemo, useCallback, useEffect, useRef, memo, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Database,
    Search,
    Layers,
    Globe,
    Building2,
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
import { TablePagination } from '@/components/ui/TablePagination'
import { resolveSourceMode, type WorkspaceResponse, type DataSourceResponse } from '@/services/workspaceService'
import type { ProviderType } from '@/services/providerService'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { SchemaAvailability } from '@/hooks/useWizardScope'
import { useDataSourceStats, type DataSourceStats } from '@/hooks/useDataSourceStats'
import { useWorkspacePage } from '@/hooks/useWorkspacePage'
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

/**
 * "Ready to build on": it has a semantic layer and its lineage has been rolled up.
 *
 * Deliberately no longer keyed off `isPrimary` — being the workspace's primary
 * source says nothing about whether a view built on it will actually work, and
 * we no longer surface primacy anywhere in this picker.
 */
function isRecommended(ds: DataSourceResponse): boolean {
    return !!ds.ontologyId && ds.aggregationStatus === 'ready'
}

/** One pill, one shape. Provenance and readiness used to be styled three different
 *  ways on the same row (a bare amber "★ Primary" beside two uppercase pills), which
 *  is what made the badge row look unsettled. */
function CardBadge({
    icon,
    label,
    tone,
    title,
}: {
    icon: ReactNode
    label: string
    tone: 'managed' | 'federated' | 'ready'
    title?: string
}) {
    const tones = {
        managed: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
        federated: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20',
        ready: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
    }[tone]

    return (
        <span
            title={title}
            className={cn(
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-md border',
                'text-[10px] font-semibold leading-none whitespace-nowrap',
                tones,
            )}
        >
            {icon}
            {label}
        </span>
    )
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

/**
 * There is exactly ONE notion of "current" in this rail: the workspace the user
 * has selected for THIS view. The app's old global active-workspace concept is
 * retired, so it is deliberately not surfaced here — a second "you are here"
 * marker pointing somewhere else is just a lie with a checkmark next to it.
 */
function WorkspaceItem({
    ws,
    isSelected,
    dsCount,
    onClick,
}: {
    ws: WorkspaceResponse
    isSelected: boolean
    dsCount: number
    onClick: () => void
}) {
    return (
        <button
            onClick={onClick}
            className={cn(
                // Comfortable, not cramped: this is a primary navigation surface, and a
                // squeezed row reads as an afterthought. Eight of these still fit the
                // step without scrolling, which is the constraint that matters.
                'w-full text-left px-3 py-2.5 rounded-xl transition-colors duration-150',
                'border',
                isSelected
                    ? 'bg-blue-600/8 dark:bg-blue-500/10 border-blue-500/30 shadow-sm'
                    : 'border-transparent hover:bg-slate-100 dark:hover:bg-slate-800/60',
            )}
        >
            <div className="flex items-center gap-2.5">
                <div className={cn(
                    'w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-[11px] font-bold',
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
                            <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 shrink-0 leading-none">
                                Default
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                        <span>{dsCount} source{dsCount !== 1 ? 's' : ''}</span>
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

/**
 * memo + a stable `onSelect(id)` (rather than a fresh `() => select(ds.id)` arrow per
 * render): typing in the search box, or a stats query resolving, used to re-render
 * every card on the page — each of which runs a provider-health store subscription
 * and a logo lookup. Now only the cards whose own data changed re-render.
 */
const DataSourceCard = memo(function DataSourceCard({
    ds,
    stats,
    statsLoading,
    isSelected,
    providerInfo,
    foreignWorkspaceName,
    onSelect,
}: {
    ds: DataSourceResponse
    stats?: DataSourceStats
    statsLoading: boolean
    isSelected: boolean
    providerInfo?: DataSourceProviderInfo
    /** Set when the source lives OUTSIDE the workspace being browsed — picking it
     *  moves the whole view there, so say so rather than moving them silently. */
    foreignWorkspaceName?: string
    onSelect: (id: string) => void
}) {
    const aggMeta = AGG_STATUS_META[ds.aggregationStatus] ?? AGG_STATUS_META.none
    const recommended = isRecommended(ds)
    const sourceMode = resolveSourceMode(ds)
    // Live provider health — providerInfo is admin-gated, but ds.providerId
    // rides the workspaces payload for everyone, so the dot works for all
    // roles (unknown = neutral gray, never blocks selection).
    const health = useProviderHealth(providerInfo?.providerId ?? ds.providerId)
    const healthMeta = PROVIDER_HEALTH_META[health.state]
    const provMeta = providerInfo ? providerMeta(providerInfo.providerType) : null
    const Logo = providerInfo ? getProviderLogo(providerInfo.providerType) : null

    return (
        <button
            onClick={() => onSelect(ds.id)}
            className={cn(
                // h-full + flex-col: the card fills its grid cell, so every card in a
                // row is the same height and their footers line up (mt-auto below).
                'relative flex h-full w-full flex-col text-left rounded-xl border-2 p-3.5 transition-colors duration-150',
                'hover:shadow-md',
                isSelected
                    ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/20 shadow-sm shadow-blue-500/10'
                    : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60 hover:border-slate-300 dark:hover:border-slate-600',
            )}
        >
            {/* Selection checkmark */}
            {isSelected && (
                <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center">
                    <Check className="w-3 h-3 text-white" />
                </div>
            )}

            {/* Header */}
            <div className="flex items-start gap-2.5">
                {/* Branded provider tile — identifies WHICH connection this source
                    lives on at a glance (three FalkorDB instances stop looking
                    identical). Falls back to the neutral Database tile when the
                    provider registry isn't readable (non-admin). */}
                <div className={cn(
                    'w-8 h-8 rounded-lg border flex items-center justify-center shrink-0',
                    Logo && provMeta
                        ? provMeta.color
                        : isSelected
                            ? 'border-transparent bg-blue-500/15 text-blue-600 dark:text-blue-400'
                            : 'border-transparent bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400',
                )}>
                    {Logo ? <Logo className="w-3.5 h-3.5" /> : <Database className="w-3.5 h-3.5" />}
                </div>
                <div className="min-w-0 flex-1 pr-5">
                    {/* Two lines are reserved whether the name needs them or not: a
                        wrapping name would otherwise push this card's provider line,
                        badges and metrics out of step with its neighbours'. */}
                    <div className="flex items-start gap-1.5 min-h-[2.1rem]">
                        <h4 className="min-w-0 text-sm font-bold leading-[1.15] text-slate-800 dark:text-slate-200 line-clamp-2 break-words">
                            {ds.label || ds.catalogItemId || 'Unnamed'}
                        </h4>
                        <span
                            className={cn('w-2 h-2 mt-1 rounded-full shrink-0', healthMeta.dot)}
                            title={health.error ?? healthMeta.label}
                        />
                    </div>
                    <div
                        className="text-[11px] leading-4 text-slate-500 dark:text-slate-400 truncate"
                        title={providerInfo ? `${providerInfo.providerName} · ${providerInfo.providerType}` : undefined}
                    >
                        {providerInfo && (
                            <>
                                {providerInfo.providerName}
                                <span className="text-slate-400 dark:text-slate-500"> · {providerInfo.providerType}</span>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Badges — their own row (not squeezed beside the logo), so they wrap
                predictably instead of shoving the header around. Every card carries
                exactly one provenance pill, so the row reads as a column. */}
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                {foreignWorkspaceName && (
                    <span
                        title={`Lives in "${foreignWorkspaceName}" — picking it builds the view there`}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10px] font-semibold leading-none max-w-full bg-slate-500/10 text-slate-600 dark:text-slate-300 border-slate-500/20"
                    >
                        <Building2 className="w-3 h-3 shrink-0" />
                        <span className="truncate">{foreignWorkspaceName}</span>
                    </span>
                )}
                {sourceMode === 'managed' ? (
                    <CardBadge
                        tone="managed"
                        icon={<Sparkles className="w-3 h-3 shrink-0" />}
                        label="Fully managed"
                        title="Created and versioned in this app — we own the graph"
                    />
                ) : (
                    <CardBadge
                        tone="federated"
                        icon={<Server className="w-3 h-3 shrink-0" />}
                        label="Federated"
                        title={`External system of record${ds.writeBackEnabled ? ' · write-back enabled' : ''}`}
                    />
                )}
                {recommended && (
                    <CardBadge
                        tone="ready"
                        icon={<Check className="w-3 h-3 shrink-0" />}
                        label="Ready"
                        title="Has a semantic layer and its lineage is rolled up"
                    />
                )}
            </div>

            {/* Metrics — ONE line that can never wrap. Three stacked columns cost two
                lines and read like a dashboard; this is a summary, so it reads as a
                sentence. Full values live in the tooltip. */}
            <div className="mt-2 mb-2.5 h-4 flex items-center text-[11px] leading-none">
                {statsLoading && !stats ? (
                    <span className="flex items-center gap-1.5 text-slate-400">
                        <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                        Loading metrics…
                    </span>
                ) : stats ? (
                    <span
                        className="min-w-0 truncate whitespace-nowrap text-slate-400"
                        title={`${stats.nodeCount.toLocaleString()} nodes · ${stats.edgeCount.toLocaleString()} edges · ${stats.entityTypes.length} entity types`}
                    >
                        <b className="font-semibold text-slate-700 dark:text-slate-300 tabular-nums">{compactNum(stats.nodeCount)}</b>
                        {' nodes '}
                        <span className="text-slate-300 dark:text-slate-600">·</span>
                        {' '}
                        <b className="font-semibold text-slate-700 dark:text-slate-300 tabular-nums">{compactNum(stats.edgeCount)}</b>
                        {' edges '}
                        <span className="text-slate-300 dark:text-slate-600">·</span>
                        {' '}
                        <b className="font-semibold text-slate-700 dark:text-slate-300 tabular-nums">{stats.entityTypes.length}</b>
                        {stats.entityTypes.length === 1 ? ' type' : ' types'}
                    </span>
                ) : (
                    <span className="text-slate-400">No metrics yet</span>
                )}
            </div>

            {/* Status row — mt-auto pins it to the bottom of the card, so every footer
                in a row sits on the same line no matter what's above it. (The metrics
                block above carries the minimum gap; mt-auto only adds slack.) */}
            <div className="flex items-center gap-2.5 mt-auto pt-2.5 border-t border-slate-100 dark:border-slate-700/50">
                {/* Aggregation status */}
                <div className="flex items-center gap-1.5 text-[11px] shrink-0">
                    <span className={cn('w-2 h-2 rounded-full shrink-0', aggMeta.dot)} />
                    <span className="text-slate-500 dark:text-slate-400">{aggMeta.label}</span>
                </div>

                {/* Ontology status */}
                <div className="flex items-center gap-1 text-[11px] shrink-0">
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
                    <div className="flex items-center gap-1 text-[11px] text-slate-400 ml-auto min-w-0">
                        <Clock className="w-3 h-3 shrink-0" />
                        <span className="truncate">{timeAgo(ds.lastAggregatedAt)}</span>
                    </div>
                )}
            </div>
        </button>
    )
})

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

function NoDataSourcesState({
    workspaceName,
    otherSourceCount,
    onSearchAll,
}: {
    workspaceName: string
    /** Sources that exist elsewhere — an empty workspace is a dead end otherwise. */
    otherSourceCount: number
    onSearchAll: () => void
}) {
    return (
        <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-12 h-12 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-3">
                <Database className="w-6 h-6 text-slate-300 dark:text-slate-600" />
            </div>
            <p className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">
                No data sources
            </p>
            <p className="text-xs text-slate-400 max-w-[240px]">
                &quot;{workspaceName}&quot; has no data sources configured yet.
            </p>
            {/* Landing on an empty workspace used to be a full stop. It isn't one:
                the source you want almost certainly exists somewhere you can see. */}
            {otherSourceCount > 0 && (
                <button
                    type="button"
                    onClick={onSearchAll}
                    className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
                >
                    <Globe className="w-3.5 h-3.5" />
                    Browse all {otherSourceCount} sources instead
                </button>
            )}
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
                // h-full: a card carrying an "offline" note must not be taller than its
                // neighbours — the grid cell decides the height, not the content.
                'relative flex h-full w-full text-left rounded-xl border-2 p-4 transition-colors duration-150',
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
            <div className="flex items-start gap-3 w-full">
                <div className={cn('w-10 h-10 rounded-xl border flex items-center justify-center shrink-0', meta.color)}>
                    <Logo className="w-5 h-5" />
                </div>
                <div className="min-w-0 flex-1 pr-6">
                    <div className="flex items-center gap-1.5">
                        <h4 className="min-w-0 text-sm font-bold text-slate-800 dark:text-slate-200 truncate">{provider.name}</h4>
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
                // h-full: a description of two lines must not make this card taller
                // than the one beside it that has none.
                'relative flex h-full w-full text-left rounded-xl border-2 p-4 transition-colors duration-150 hover:shadow-md',
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
            <div className="flex items-start gap-3 w-full">
                <div className="w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 text-violet-500 bg-violet-500/10 border-violet-500/20">
                    <Sparkles className="w-5 h-5" />
                </div>
                <div className="min-w-0 flex-1 pr-6">
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <h4 className="min-w-0 text-sm font-bold text-slate-800 dark:text-slate-200 truncate">{ontology.name}</h4>
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
                            <div className="grid gap-3 sm:grid-cols-2 items-stretch">
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
                    <div className="grid gap-3 sm:grid-cols-2 items-stretch">
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

const NO_FILTERS = { ontology: false, ready: false }

/** Exactly three rows at lg (3×3) — the tallest grid that still lets the whole
 *  step fit on screen without the modal scrolling. */
const DS_PAGE_SIZE = 9
/** The rail's height drives the step's height, and the step has to fit. Eight rows
 *  is what fits alongside three rows of cards without anything scrolling. */
const WS_PAGE_SIZE = 8

export function ScopeStep({
    availableWorkspaces,
    schemaAvailability,
    selectedWorkspaceId,
    selectedDataSourceId,
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
    const [wsSearch, setWsSearch] = useState('')
    const [dsSearch, setDsSearch] = useState('')
    const [dsSort, setDsSort] = useState<DsSort>('recommended')
    const [dsFilters, setDsFilters] = useState(NO_FILTERS)
    const [dsPage, setDsPage] = useState(0)
    const [wsPage, setWsPage] = useState(0)
    /** Search every workspace at once, not just the selected one. */
    const [searchAllWorkspaces, setSearchAllWorkspaces] = useState(false)

    // Resolves the provider (e.g. falkordb/neo4j) each data source is built on.
    const { resolve: resolveProvider } = useDataSourceProviderMap()

    // Picking a global result changes the workspace as a CONSEQUENCE of the pick.
    // Without this guard the reset below would fire and wipe the very query that
    // found it, dumping the user in the new workspace's full list.
    const keepSearchOnScopeChange = useRef(false)

    // Reset data-source search/sort/filters when the workspace changes so
    // filters don't leak across workspaces.
    useEffect(() => {
        if (keepSearchOnScopeChange.current) {
            keepSearchOnScopeChange.current = false
            return
        }
        setDsSearch('')
        setDsSort('recommended')
        setDsFilters(NO_FILTERS)
        setDsPage(0)
        setSearchAllWorkspaces(false)
    }, [selectedWorkspaceId])

    // Any search/sort/filter/scope change re-slices the list — jump back to page 1.
    useEffect(() => {
        setDsPage(0)
    }, [dsSearch, dsSort, dsFilters, searchAllWorkspaces])

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

    // ── Workspace rail: server-paginated ─────────────────────────────────────
    // The rail only DISPLAYS workspaces; selection still resolves against the
    // store-provided `availableWorkspaces` (the wizard's scope, auto-select and
    // deep-link paths all read from it), so paging can never strand a selection
    // that lives on another page.
    const [wsSearchDebounced, setWsSearchDebounced] = useState('')
    useEffect(() => {
        const t = setTimeout(() => setWsSearchDebounced(wsSearch), 250)
        return () => clearTimeout(t)
    }, [wsSearch])

    // A new query means a new result set — start at its first page.
    useEffect(() => { setWsPage(0) }, [wsSearchDebounced])

    const {
        workspaces: pagedWorkspaces,
        totalCount: wsTotalCount,
        isLoading: wsPageLoading,
        isError: wsPageError,
        refetch: refetchWorkspacePage,
    } = useWorkspacePage({
        page: wsPage,
        pageSize: WS_PAGE_SIZE,
        search: wsSearchDebounced,
        enabled: !singleWorkspace,
    })

    // Prefer the store's copy of each row (it's the one the rest of the wizard
    // resolves against) but fall back to the server's — a workspace can legally
    // appear on a page before the store's full list has refreshed.
    const railWorkspaces = useMemo(
        () => pagedWorkspaces.map(ws => availableWorkspaces.find(w => w.id === ws.id) ?? ws),
        [pagedWorkspaces, availableWorkspaces],
    )

    /** Does this source match the query? (name, catalog id, provider — and, when
     *  searching globally, the workspace it lives in.) */
    const matchesQuery = useCallback((ds: DataSourceResponse, q: string, wsName?: string) => {
        if (!q) return true
        const prov = resolveProvider(ds.id)
        const haystack = [
            ds.label,
            ds.catalogItemId,
            prov?.providerName,
            prov?.providerType,
            wsName,
        ].filter(Boolean).join(' ').toLowerCase()
        return haystack.includes(q)
    }, [resolveProvider])

    // Every source the user can reach, with the workspace it belongs to. A source
    // belongs to exactly one workspace, so picking one here determines both — the
    // workspace rail is a browsing aid, not a decision the user owes us first.
    const allDataSources = useMemo(
        () => availableWorkspaces.flatMap(ws =>
            (ws.dataSources ?? []).map(ds => ({ ds, workspaceName: ws.name }))),
        [availableWorkspaces],
    )

    const workspaceNameById = useMemo(
        () => new Map(availableWorkspaces.map(ws => [ws.id, ws.name])),
        [availableWorkspaces],
    )

    /** Sources exist SOMEWHERE the user can see. An empty selected workspace must
     *  still offer the search — otherwise landing on one is a dead end, and most
     *  workspaces in a real estate are empty. */
    const hasAnySources = allDataSources.length > 0

    /** Matches in OTHER workspaces — powers the "0 here, 3 elsewhere" rescue. */
    const matchesElsewhere = useMemo(() => {
        const q = dsSearch.trim().toLowerCase()
        if (!q || searchAllWorkspaces) return 0
        return allDataSources.filter(({ ds, workspaceName }) =>
            ds.workspaceId !== selectedWorkspaceId && matchesQuery(ds, q, workspaceName)
        ).length
    }, [dsSearch, searchAllWorkspaces, allDataSources, selectedWorkspaceId, matchesQuery])

    // Filter + sort the data sources for display.
    const visibleDataSources = useMemo(() => {
        const q = dsSearch.trim().toLowerCase()
        const pool = searchAllWorkspaces
            ? allDataSources
            : dataSources.map(ds => ({ ds, workspaceName: selectedWorkspace?.name }))

        const filtered = pool.filter(({ ds, workspaceName }) => {
            if (dsFilters.ontology && !ds.ontologyId) return false
            if (dsFilters.ready && ds.aggregationStatus !== 'ready') return false
            if (!matchesQuery(ds, q, searchAllWorkspaces ? workspaceName : undefined)) return false
            return true
        }).map(({ ds }) => ds)

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
                    // Sources you can actually build on float up; primacy is no longer
                    // a tiebreaker because it says nothing about that.
                    const aRec = isRecommended(a) ? 0 : 1
                    const bRec = isRecommended(b) ? 0 : 1
                    if (aRec !== bRec) return aRec - bRec
                    return dsName(a).localeCompare(dsName(b))
                }
            }
        })
    }, [
        dataSources, selectedWorkspace, allDataSources, searchAllWorkspaces,
        dsSearch, dsSort, dsFilters, matchesQuery,
    ])

    // Clamp the page when the filtered list shrinks below the current page.
    const dsPageCount = Math.max(1, Math.ceil(visibleDataSources.length / DS_PAGE_SIZE))
    useEffect(() => {
        if (dsPage > dsPageCount - 1) setDsPage(dsPageCount - 1)
    }, [dsPage, dsPageCount])

    // Current page of cards (grid renders one page at a time).
    const pagedDataSources = useMemo(
        () => visibleDataSources.slice(dsPage * DS_PAGE_SIZE, (dsPage + 1) * DS_PAGE_SIZE),
        [visibleDataSources, dsPage],
    )

    // Fetch cached stats only for the current PAGE (not eagerly for the estate).
    // Each source carries its own workspace, so a page of global results fetches
    // correctly even though its cards come from different workspaces.
    const visibleDsRefs = useMemo(
        () => pagedDataSources.map(ds => ({ workspaceId: ds.workspaceId, dataSourceId: ds.id })),
        [pagedDataSources],
    )
    const { statsMap, isLoading: statsLoading } = useDataSourceStats(visibleDsRefs)

    const hasActiveDsFilter = !!dsSearch.trim() || dsFilters.ontology || dsFilters.ready
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

    /**
     * Pick a source, wherever it lives.
     *
     * A source belongs to exactly one workspace, so choosing it settles the
     * workspace too — the user shouldn't have to go and find the right rail entry
     * first. The guard keeps their search query alive across the scope change.
     */
    const handleSelectDataSource = useCallback((dsId: string) => {
        const found = allDataSources.find(({ ds }) => ds.id === dsId)?.ds
        if (found && found.workspaceId !== selectedWorkspaceId) {
            keepSearchOnScopeChange.current = true
            onSelectWorkspace(found.workspaceId)
        }
        onSelectDataSource(dsId)
    }, [allDataSources, selectedWorkspaceId, onSelectWorkspace, onSelectDataSource])

    if (availableWorkspaces.length === 0) {
        return <NoWorkspacesState />
    }

    return (
        <div className="space-y-4">
            {/* Intro — deliberately compact. Everything above the picker is height the
                picker doesn't get, and the picker is the thing people came for. */}
            <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.12 }}
                className="text-center"
            >
                <h3 className="text-xl font-bold text-slate-900 dark:text-white">
                    Where should this view live?
                </h3>
                <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
                    {isBlank
                        ? 'Pick a workspace, a FalkorDB connection, and a published semantic layer'
                        : 'Select the workspace and data source this view will be built from'}
                </p>
            </motion.div>

            {/* Mode toggle */}
            <div className="flex justify-center">
                <ScopeModeToggle mode={scopeMode} onChange={onScopeModeChange} />
            </div>

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
                {/* Left: Workspace rail — server-paginated, so it stays a short
                    list whether the estate has 5 workspaces or 5,000. */}
                {!singleWorkspace && (
                    <div className="w-[240px] shrink-0 border-r border-slate-200 dark:border-slate-700 flex flex-col">
                        {/* Search (server-side, debounced) */}
                        <div className="p-2.5 border-b border-slate-100 dark:border-slate-700/50">
                            <div className="relative">
                                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                                <input
                                    type="text"
                                    placeholder="Search workspaces..."
                                    value={wsSearch}
                                    onChange={e => setWsSearch(e.target.value)}
                                    className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 placeholder:text-slate-400 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/30 transition-colors"
                                />
                            </div>
                        </div>

                        {/* Workspace list */}
                        <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
                            {wsPageLoading ? (
                                Array.from({ length: 5 }).map((_, i) => (
                                    <div key={i} className="px-3.5 py-3 rounded-xl animate-pulse">
                                        <div className="flex items-center gap-2.5">
                                            <div className="w-7 h-7 rounded-lg bg-slate-200 dark:bg-slate-700 shrink-0" />
                                            <div className="flex-1 space-y-1.5">
                                                <div className="h-2.5 w-2/3 bg-slate-200 dark:bg-slate-700 rounded" />
                                                <div className="h-2 w-1/3 bg-slate-100 dark:bg-slate-800 rounded" />
                                            </div>
                                        </div>
                                    </div>
                                ))
                            ) : wsPageError ? (
                                <div className="py-6 text-center">
                                    <p className="text-xs text-slate-400">Couldn’t load workspaces</p>
                                    <button
                                        type="button"
                                        onClick={refetchWorkspacePage}
                                        className="mt-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                                    >
                                        Try again
                                    </button>
                                </div>
                            ) : (
                                <>
                                    {railWorkspaces.map(ws => (
                                        <WorkspaceItem
                                            key={ws.id}
                                            ws={ws}
                                            isSelected={ws.id === selectedWorkspaceId}
                                            dsCount={ws.dataSources?.length ?? 0}
                                            onClick={() => handleSelectWorkspace(ws.id)}
                                        />
                                    ))}
                                    {railWorkspaces.length === 0 && (
                                        <div className="py-6 text-center text-xs text-slate-400">
                                            {wsSearch
                                                ? `No workspaces match "${wsSearch}"`
                                                : 'No workspaces available'}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>

                        {/* Pager (self-hides when everything fits on one page) */}
                        <div className="border-t border-slate-100 dark:border-slate-700/50 px-2 py-1.5 flex justify-center">
                            <TablePagination
                                page={wsPage}
                                pageSize={WS_PAGE_SIZE}
                                total={wsTotalCount}
                                onPageChange={setWsPage}
                            />
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
                                    {searchAllWorkspaces ? (
                                        <>
                                            <Globe className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                                            <span className="text-xs text-slate-400">Data sources across</span>
                                            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                                                all workspaces
                                            </span>
                                        </>
                                    ) : (
                                        <>
                                            <GitBranch className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                            <span className="text-xs text-slate-400">Data sources in</span>
                                            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 truncate">
                                                {selectedWorkspace.name}
                                            </span>
                                        </>
                                    )}
                                    <span className="text-xs text-slate-400 ml-auto shrink-0">
                                        {(() => {
                                            const total = searchAllWorkspaces ? allDataSources.length : dataSources.length
                                            return visibleDataSources.length === total
                                                ? `${total} source${total !== 1 ? 's' : ''}`
                                                : `${visibleDataSources.length} of ${total} sources`
                                        })()}
                                    </span>
                                </div>

                                {hasAnySources && (
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

                                        {/* Search scope. A real toggle, not just a search
                                            modifier: with no query it simply lists every
                                            source you can pick — which is the fastest route
                                            when most workspaces are empty anyway. */}
                                        {availableWorkspaces.length > 1 && (
                                            <button
                                                type="button"
                                                onClick={() => setSearchAllWorkspaces(v => !v)}
                                                title="Search data sources across every workspace you can see"
                                                className={cn(
                                                    'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors shrink-0',
                                                    searchAllWorkspaces
                                                        ? 'border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400'
                                                        : 'border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
                                                )}
                                            >
                                                <Globe className="w-3.5 h-3.5" />
                                                All workspaces
                                            </button>
                                        )}

                                        {/* Sort */}
                                        <DataSourceSortControl sort={dsSort} onSortChange={setDsSort} />

                                        {/* Page controls (hidden when one page fits) */}
                                        <TablePagination
                                            page={dsPage}
                                            pageSize={DS_PAGE_SIZE}
                                            total={visibleDataSources.length}
                                            onPageChange={setDsPage}
                                        />
                                    </div>
                                )}

                                {/* The rescue. Costs nothing when you don't need it, and
                                    appears exactly when you're looking in the wrong place. */}
                                {matchesElsewhere > 0 && (
                                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-blue-500/20 bg-blue-500/5">
                                        <Globe className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                                        <span className="text-[11px] text-slate-600 dark:text-slate-300 min-w-0">
                                            {visibleDataSources.length === 0
                                                ? <>No matches in <strong>{selectedWorkspace.name}</strong>.</>
                                                : <>More matches outside <strong>{selectedWorkspace.name}</strong>.</>}
                                            {' '}
                                            <strong>{matchesElsewhere}</strong>
                                            {matchesElsewhere === 1 ? ' match' : ' matches'} in other workspaces.
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => setSearchAllWorkspaces(true)}
                                            className="ml-auto shrink-0 text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:underline"
                                        >
                                            Search all →
                                        </button>
                                    </div>
                                )}

                                {hasAnySources && (
                                    <div className="flex items-center gap-1.5 flex-wrap">
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
                            {dataSources.length === 0 && !searchAllWorkspaces ? (
                                <NoDataSourcesState
                                    workspaceName={selectedWorkspace.name}
                                    otherSourceCount={allDataSources.length}
                                    onSearchAll={() => setSearchAllWorkspaces(true)}
                                />
                            ) : visibleDataSources.length > 0 ? (
                                <div className="flex-1 overflow-y-auto p-3.5 custom-scrollbar">
                                    {/* A FIXED column count. It used to widen the cards when a
                                        page happened to hold one or two sources — which meant the
                                        last page of a paginated list rendered at a completely
                                        different size from the first. */}
                                    <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 items-stretch">
                                        {pagedDataSources.map((ds, i) => (
                                            <motion.div
                                                key={ds.id}
                                                initial={{ opacity: 0, y: 8 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                transition={{ duration: 0.12, delay: Math.min(i * 0.01, 0.05) }}
                                                className="h-full"
                                            >
                                                <DataSourceCard
                                                    ds={ds}
                                                    stats={statsMap[`${ds.workspaceId}/${ds.id}`]}
                                                    statsLoading={statsLoading}
                                                    isSelected={ds.id === selectedDataSourceId}
                                                    providerInfo={resolveProvider(ds.id)}
                                                    foreignWorkspaceName={
                                                        ds.workspaceId !== selectedWorkspaceId
                                                            ? workspaceNameById.get(ds.workspaceId)
                                                            : undefined
                                                    }
                                                    onSelect={handleSelectDataSource}
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
