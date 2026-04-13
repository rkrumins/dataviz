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

import { useState, useMemo, useCallback, useEffect } from 'react'
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
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import type { WorkspaceResponse, DataSourceResponse } from '@/services/workspaceService'
import type { DataSourceStats, SchemaAvailability } from '@/hooks/useWizardScope'

// ─── Types ─────────────────────────────────────────────────────────

export interface ScopeStepProps {
    availableWorkspaces: WorkspaceResponse[]
    statsMap: Record<string, DataSourceStats>
    statsLoading: boolean
    /** Schema availability for the currently selected data source (authoritative). */
    schemaAvailability: SchemaAvailability
    selectedWorkspaceId: string | null
    selectedDataSourceId: string | null
    activeWorkspaceId: string | null
    onSelectWorkspace: (wsId: string) => void
    onSelectDataSource: (dsId: string) => void
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
                'w-full text-left px-3.5 py-3 rounded-xl transition-all duration-150',
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
    onClick,
}: {
    ds: DataSourceResponse
    stats?: DataSourceStats
    statsLoading: boolean
    isSelected: boolean
    onClick: () => void
}) {
    const aggMeta = AGG_STATUS_META[ds.aggregationStatus] ?? AGG_STATUS_META.none
    const recommended = isRecommended(ds)

    return (
        <button
            onClick={onClick}
            className={cn(
                'relative w-full text-left rounded-xl border-2 p-4 transition-all duration-150',
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
                    <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200 truncate">
                        {ds.label || ds.catalogItemId || 'Unnamed'}
                    </h4>
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
                    transition={{ duration: 0.15 }}
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
                    transition={{ duration: 0.15 }}
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
                    transition={{ duration: 0.15 }}
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
                    transition={{ duration: 0.15 }}
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

// ─── Main Component ────────────────────────────────────────────────

export function ScopeStep({
    availableWorkspaces,
    statsMap,
    statsLoading,
    schemaAvailability,
    selectedWorkspaceId,
    selectedDataSourceId,
    activeWorkspaceId,
    onSelectWorkspace,
    onSelectDataSource,
}: ScopeStepProps) {
    const [wsSearch, setWsSearch] = useState('')

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

    const dataSources = selectedWorkspace?.dataSources ?? []

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

    // Sort data sources: recommended first, then primary, then alphabetical
    const sortedDataSources = useMemo(() => {
        return [...dataSources].sort((a, b) => {
            const aRec = isRecommended(a) ? -2 : a.isPrimary ? -1 : 0
            const bRec = isRecommended(b) ? -2 : b.isPrimary ? -1 : 0
            if (aRec !== bRec) return aRec - bRec
            return (a.label || a.catalogItemId || '').localeCompare(b.label || b.catalogItemId || '')
        })
    }, [dataSources])

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
                transition={{ duration: 0.15 }}
                className="text-center mb-2"
            >
                <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 text-sm font-medium mb-3">
                    <Database className="w-4 h-4" />
                    Choose your data source
                </div>
                <h3 className="text-2xl font-bold text-slate-900 dark:text-white mb-1.5">
                    Where should this view live?
                </h3>
                <p className="text-slate-500 dark:text-slate-400 text-sm">
                    Select the workspace and data source this view will be built from
                </p>
            </motion.div>

            {/* Two-panel layout */}
            <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: 0.05 }}
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

                {/* Right: Data Source Cards */}
                <div className="flex-1 flex flex-col min-w-0">
                    {selectedWorkspace ? (
                        <>
                            {/* Right header */}
                            <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-700/50 flex items-center gap-2">
                                <GitBranch className="w-3.5 h-3.5 text-slate-400" />
                                <span className="text-xs text-slate-400">
                                    {singleWorkspace ? 'Data sources in' : 'Data sources in'}
                                </span>
                                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                                    {selectedWorkspace.name}
                                </span>
                                <span className="text-xs text-slate-400 ml-auto">
                                    {dataSources.length} available
                                </span>
                            </div>

                            {/* Data source grid */}
                            {sortedDataSources.length > 0 ? (
                                <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                                    <div className={cn(
                                        'grid gap-3',
                                        sortedDataSources.length === 1
                                            ? 'grid-cols-1 max-w-md'
                                            : sortedDataSources.length === 2
                                                ? 'grid-cols-1 sm:grid-cols-2'
                                                : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
                                    )}>
                                        {sortedDataSources.map((ds, i) => (
                                            <motion.div
                                                key={ds.id}
                                                initial={{ opacity: 0, y: 8 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                transition={{ duration: 0.15, delay: i * 0.03 }}
                                            >
                                                <DataSourceCard
                                                    ds={ds}
                                                    stats={statsMap[`${selectedWorkspaceId}/${ds.id}`]}
                                                    statsLoading={statsLoading}
                                                    isSelected={ds.id === selectedDataSourceId}
                                                    onClick={() => onSelectDataSource(ds.id)}
                                                />
                                            </motion.div>
                                        ))}
                                    </div>
                                </div>
                            ) : (
                                <NoDataSourcesState workspaceName={selectedWorkspace.name} />
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

            {/* Contextual banners */}
            <ScopeBanners ds={selectedDs} schemaAvailability={schemaAvailability} />
        </div>
    )
}

export default ScopeStep
