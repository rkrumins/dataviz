/**
 * DataSourceDetailPanel — slide-in drawer for data source details.
 * Renders as a right-side panel via portal (same pattern as ExplorerPreviewDrawer).
 * Tabs: Insights · Aggregation · Views
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Database, Edit2, Trash2, X, ExternalLink, Settings2, Plus, Eye,
    BarChart3, AlertTriangle, Loader2,
    GitBranch, Star, Clock, Compass, Save, RotateCcw,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import type { DataSourceResponse } from '@/services/workspaceService'
import type { DataSourceStats } from '@/hooks/useDashboardData'
import type { View } from '@/services/viewApiService'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { DataSourceReadinessResponse } from '@/services/aggregationService'
import { AggregationHistory } from '../AggregationHistory'
import { getProviderLogo } from '../ProviderLogos'
import { usePermission } from '@/store/auth'
import { DataSourceVersioningTab } from '@/features/versioning/components/DataSourceVersioningTab'
import { VocabAlignmentWarning } from './VocabAlignmentWarning'
import type { DataSourceProviderInfo } from './useWorkspaceDetailData'
import { DataSourceProfile, type DataSourceProfileContext } from '@/components/insights/DataSourceProfile'

// ─────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────

export interface AggregationConfigSnapshot {
    projectionMode: string
    dedicatedGraphName: string
}

interface DataSourceDetailPanelProps {
    ds: DataSourceResponse | null
    wsId: string
    isOpen: boolean
    stats?: DataSourceStats
    providerInfo?: DataSourceProviderInfo
    ontologyName?: string
    ontologyId?: string
    views: View[]
    /** Live aggregation readiness — drives the header pill so it agrees with
     *  the Overview's Aggregation card (the persisted ds.aggregationStatus can
     *  lag behind the live state). */
    readiness?: DataSourceReadinessResponse
    /** Ontologies selectable in the inline edit panel. */
    ontologies: OntologyDefinitionResponse[]
    /** Persist an inline metadata edit (label + ontology). Replaces the old
     *  separate Edit-Data-Source modal. */
    onSaveEdit: (label: string, ontologyId: string | undefined) => Promise<void> | void
    onDelete?: () => void
    onReaggregate: () => void
    onPurge: () => Promise<void>
    onSetPrimary: () => void
    /**
     * Persist the Aggregation tab as a single transaction. Receives both the
     * pending edits (local) and the original snapshot (server) so the parent
     * can compute a minimal PATCH.
     */
    onSaveAggregationConfig: (
        pending: AggregationConfigSnapshot,
        original: AggregationConfigSnapshot,
    ) => Promise<void>
    onClose: () => void
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

const AGG_STATUS_META: Record<string, { label: string; dot: string; text: string }> = {
    ready: { label: 'Ready', dot: 'bg-emerald-400', text: 'text-emerald-600 dark:text-emerald-400' },
    running: { label: 'Running', dot: 'bg-indigo-400 animate-pulse', text: 'text-indigo-600 dark:text-indigo-400' },
    pending: { label: 'Pending', dot: 'bg-amber-400 animate-pulse', text: 'text-amber-600 dark:text-amber-400' },
    failed: { label: 'Failed', dot: 'bg-red-400', text: 'text-red-600 dark:text-red-400' },
    skipped: { label: 'Skipped', dot: 'bg-gray-400', text: 'text-ink-muted' },
    none: { label: 'Not Started', dot: 'bg-gray-400', text: 'text-ink-muted' },
}

// ─────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────

function TabBtn({ active, icon: Icon, label, count, onClick }: {
    active: boolean
    icon: React.ComponentType<{ className?: string }>
    label: string
    count?: number
    onClick: () => void
}) {
    return (
        <button
            onClick={onClick}
            className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors duration-150",
                active
                    ? "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20"
                    : "text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 border border-transparent"
            )}
        >
            <Icon className="w-3 h-3" />
            {label}
            {count !== undefined && count > 0 && (
                <span className={cn(
                    "ml-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold",
                    active ? "bg-indigo-500/20 text-indigo-600 dark:text-indigo-400" : "bg-black/5 dark:bg-white/5 text-ink-muted"
                )}>
                    {count}
                </span>
            )}
        </button>
    )
}

// ─────────────────────────────────────────────────────────────────────
// DataSourceDetailPanel (Drawer)
// ─────────────────────────────────────────────────────────────────────

export function DataSourceDetailPanel({
    ds,
    wsId,
    isOpen,
    providerInfo,
    ontologyName,
    ontologyId,
    views,
    readiness,
    ontologies,
    onSaveEdit,
    onDelete,
    onReaggregate,
    onPurge,
    onSaveAggregationConfig,
    onClose,
}: DataSourceDetailPanelProps) {
    const [activeTab, setActiveTab] = useState<'insights' | 'aggregation' | 'views' | 'versioning'>('insights')
    const [purgeConfirm, setPurgeConfirm] = useState(false)
    const [purgeLoading, setPurgeLoading] = useState(false)
    // Inline edit (label + ontology) — replaces the old modal-over-drawer.
    const [editing, setEditing] = useState(false)
    const [editLabel, setEditLabel] = useState('')
    const [editOntologyId, setEditOntologyId] = useState('')
    const [savingEdit, setSavingEdit] = useState(false)
    const startEditing = () => {
        setEditLabel(ds?.label || '')
        setEditOntologyId(ds?.ontologyId || '')
        setEditing(true)
    }
    const saveEdit = async () => {
        setSavingEdit(true)
        try {
            await onSaveEdit(editLabel.trim(), editOntologyId || undefined)
            setEditing(false)
        } finally {
            setSavingEdit(false)
        }
    }
    // Leaving edit mode when the drawer closes/opens on a different source.
    useEffect(() => { setEditing(false) }, [ds?.id])
    // Aggregation mutations (config save / re-trigger / purge) require
    // workspace:datasource:manage. system:admin is implied through
    // has_permission's shortcut chain.
    const canManageDs = usePermission(
        'workspace:datasource:manage', wsId,
    )

    // ── Aggregation tab: pending edits live entirely in local state until the
    //    user clicks Save. This avoids per-keystroke API calls and full-page
    //    reloads that would unmount this drawer mid-interaction.
    const originalMode = ds?.projectionMode ?? ''
    const originalDedicatedName = ds?.dedicatedGraphName ?? ''
    const [pendingMode, setPendingMode] = useState(originalMode)
    const [pendingDedicatedName, setPendingDedicatedName] = useState(originalDedicatedName)
    const [isSaving, setIsSaving] = useState(false)

    // Reset pending state whenever the drawer points at a different DS, or when
    // a reload has brought fresh server values (originals) for the same DS.
    useEffect(() => {
        setPendingMode(originalMode)
        setPendingDedicatedName(originalDedicatedName)
        setIsSaving(false)
    }, [ds?.id, originalMode, originalDedicatedName])

    const isDirty = pendingMode !== originalMode || pendingDedicatedName !== originalDedicatedName
    const isOverridden = !!pendingMode

    const handleSelectInherit = () => setPendingMode('')
    const handleSelectInSource = () => setPendingMode('in_source')
    const handleSelectDedicated = () => {
        setPendingMode('dedicated')
        if (!pendingDedicatedName && ds) {
            setPendingDedicatedName(`${ds.label || ds.catalogItemId}_aggregated`)
        }
    }

    const handleSaveConfig = async () => {
        if (!ds || !isDirty || isSaving) return
        setIsSaving(true)
        try {
            await onSaveAggregationConfig(
                { projectionMode: pendingMode, dedicatedGraphName: pendingDedicatedName },
                { projectionMode: originalMode, dedicatedGraphName: originalDedicatedName },
            )
            // The parent triggers a reload after save. The useEffect above will
            // resync pending state when the new originals arrive.
        } finally {
            setIsSaving(false)
        }
    }

    const handleDiscardConfig = () => {
        setPendingMode(originalMode)
        setPendingDedicatedName(originalDedicatedName)
    }

    // Prefer the LIVE readiness status over the persisted ds.aggregationStatus
    // so the header pill agrees with the Overview's Aggregation card.
    const liveAggStatus = readiness?.aggregationStatus ?? ds?.aggregationStatus
    const liveLastAggregatedAt = readiness?.lastAggregatedAt ?? ds?.lastAggregatedAt
    const aggMeta = AGG_STATUS_META[liveAggStatus || 'none'] || AGG_STATUS_META.none

    const content = (
        <>
            {/* Backdrop — plain CSS transition, never inside AnimatePresence (fixes the
                StrictMode click-shield where a stranded fixed-inset-0 node eats clicks). */}
            <Backdrop open={!!(isOpen && ds)} onClick={onClose} zClassName="z-[60]" />

            {/* Drawer panel — keyed single child so AnimatePresence tracks its exit cleanly */}
            <AnimatePresence>
                {isOpen && ds && (
                    <motion.aside
                        key="data-source-detail-drawer"
                        className={cn(
                            'fixed right-0 top-0 h-full w-[480px] max-w-[92vw] z-[61]',
                            'bg-canvas border-l border-glass-border',
                            'flex flex-col shadow-lg',
                        )}
                        initial={{ x: 480 }}
                        animate={{ x: 0 }}
                        exit={{ x: 480 }}
                        transition={{ type: 'spring', damping: 30, stiffness: 300 }}
                    >
                        {/* ── Header ─────────────────────────────────────── */}
                        <div className="px-6 pt-6 pb-4 border-b border-glass-border/50 shrink-0">
                            <div className="flex items-start justify-between gap-3 mb-4">
                                <div className="flex items-center gap-3 min-w-0">
                                    <div className="w-10 h-10 rounded-xl bg-indigo-500/15 border border-indigo-500/20 flex items-center justify-center shrink-0">
                                        {providerInfo ? (
                                            (() => { const Logo = getProviderLogo(providerInfo.providerType); return <Logo className="w-5 h-5" /> })()
                                        ) : (
                                            <Database className="w-5 h-5 text-indigo-500" />
                                        )}
                                    </div>
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <h2 className="text-lg font-bold text-ink truncate">{ds.label || providerInfo?.catalogItemName || 'Unnamed'}</h2>
                                            {ds.isPrimary && (
                                                <span className="flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 shrink-0">
                                                    <Star className="w-2.5 h-2.5" /> Primary
                                                </span>
                                            )}
                                        </div>
                                        {providerInfo ? (
                                            <p className="text-[11px] text-ink-muted truncate">
                                                <span className="font-medium">{providerInfo.providerName}</span>
                                                {providerInfo.sourceIdentifier && <span className="font-mono"> / {providerInfo.sourceIdentifier}</span>}
                                            </p>
                                        ) : (
                                            <p className="text-[11px] text-ink-muted font-mono truncate">{ds.catalogItemId}</p>
                                        )}
                                    </div>
                                </div>
                                <button onClick={onClose} className="p-2 rounded-xl text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors shrink-0">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>

                            {/* Status + meta badges */}
                            <div className="flex flex-wrap items-center gap-2 mb-4">
                                <span
                                    title="Lineage aggregation — whether this source's rolled-up lineage has been built. Trigger or manage it in the Aggregation tab."
                                    className={cn("flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-full border", aggMeta.text,
                                    liveAggStatus === 'ready' ? 'bg-emerald-500/10 border-emerald-500/20' :
                                    liveAggStatus === 'failed' ? 'bg-red-500/10 border-red-500/20' :
                                    liveAggStatus === 'running' || liveAggStatus === 'pending' ? 'bg-amber-500/10 border-amber-500/20' :
                                    'bg-black/5 dark:bg-white/5 border-glass-border'
                                )}>
                                    <span className={cn("w-2 h-2 rounded-full", aggMeta.dot)} />
                                    Lineage: {aggMeta.label}
                                </span>
                                {ontologyName && (
                                    <Link
                                        to={ontologyId ? `/schema/${ontologyId}` : '/schema'}
                                        className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20 hover:bg-violet-500/20 transition-colors"
                                    >
                                        <GitBranch className="w-3 h-3" /> {ontologyName}
                                    </Link>
                                )}
                                {liveLastAggregatedAt && (
                                    <span className="flex items-center gap-1 text-[10px] text-ink-muted">
                                        <Clock className="w-3 h-3" /> Aggregated {new Date(liveLastAggregatedAt).toLocaleDateString()}
                                    </span>
                                )}
                            </div>

                            {/* Quick action buttons */}
                            <div className="flex items-center gap-2">
                                <Link
                                    to={`/schema?workspaceId=${wsId}&dataSourceId=${ds.id}`}
                                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-500 text-white text-[11px] font-semibold hover:bg-indigo-600 transition-colors"
                                >
                                    <ExternalLink className="w-3 h-3" /> Schema Editor
                                </Link>
                                <Link
                                    to={`/explorer?workspace=${wsId}&dataSource=${ds.id}`}
                                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-glass-border text-[11px] font-semibold text-ink hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                                >
                                    <Compass className="w-3 h-3" /> Explorer
                                </Link>
                                <DataSourceActions
                                    wsId={wsId}
                                    onEdit={startEditing}
                                    onDelete={onDelete}
                                />
                                {/* DataSourceActions handles permission gating per
                                    workspace; falls back to hidden buttons if the
                                    viewer can't manage data sources here. */}
                            </div>
                        </div>

                        {/* Per-source vocabulary-alignment drift (Task E) — own component,
                            no overlap with the header chips. */}
                        {!editing && <VocabAlignmentWarning wsId={wsId} dataSourceId={ds.id} />}

                        {/* ── Tab Bar ────────────────────────────────────── */}
                        {!editing && (
                        <div className="px-6 pt-3 pb-2 flex items-center gap-1.5 shrink-0 border-b border-glass-border/30">
                            <TabBtn active={activeTab === 'insights'} icon={BarChart3} label="Overview" onClick={() => setActiveTab('insights')} />
                            <TabBtn active={activeTab === 'aggregation'} icon={Settings2} label="Aggregation" onClick={() => setActiveTab('aggregation')} />
                            <TabBtn active={activeTab === 'views'} icon={Eye} label="Views" count={views.length} onClick={() => setActiveTab('views')} />
                            <TabBtn active={activeTab === 'versioning'} icon={GitBranch} label="Versioning" onClick={() => setActiveTab('versioning')} />
                        </div>
                        )}

                        {/* ── Content (scrollable): inline edit OR the active tab ── */}
                        <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-5">
                            {editing ? (
                            <div className="max-w-lg mx-auto space-y-5 animate-in fade-in duration-200">
                                <div>
                                    <h3 className="text-base font-bold text-ink">Edit data source</h3>
                                    <p className="text-xs text-ink-muted mt-0.5">Update how this source appears and which semantic layer classifies it.</p>
                                </div>
                                <div>
                                    <label className="block text-sm font-semibold text-ink mb-1.5">Display name</label>
                                    <input value={editLabel} onChange={e => setEditLabel(e.target.value)} placeholder={ds.label || 'e.g. Production Graph'}
                                        className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50" />
                                    <p className="text-xs text-ink-muted mt-1.5">A friendly label shown across the workspace. The underlying source id doesn't change.</p>
                                </div>
                                <div>
                                    <label className="block text-sm font-semibold text-ink mb-1.5">Semantic layer (ontology)</label>
                                    <select value={editOntologyId} onChange={e => setEditOntologyId(e.target.value)}
                                        className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50">
                                        <option value="">None — use system defaults</option>
                                        {ontologies.map(o => <option key={o.id} value={o.id}>{o.name} v{o.version}{o.isPublished ? '' : ' (draft)'}</option>)}
                                    </select>
                                    <p className="text-xs text-ink-muted mt-1.5">Assigns the ontology that resolves this source's entity and relationship types.</p>
                                </div>
                                <div className="rounded-xl bg-black/[0.03] dark:bg-white/[0.03] border border-glass-border px-4 py-3">
                                    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Source</p>
                                    <p className="text-xs font-mono text-ink-secondary mt-1 break-all">{ds.catalogItemId}</p>
                                </div>
                                <div className="flex items-center justify-end gap-2 pt-1">
                                    <button onClick={() => setEditing(false)} disabled={savingEdit} className="px-4 py-2 rounded-xl text-sm font-semibold text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50">Cancel</button>
                                    <button onClick={saveEdit} disabled={savingEdit} className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-bold shadow-md shadow-indigo-500/20 transition-colors disabled:opacity-60">
                                        {savingEdit ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save changes
                                    </button>
                                </div>
                            </div>
                            ) : (<>
                            {/* ─── Insights Tab ─────────────────────────── */}
                            {activeTab === 'insights' && (
                                ds.catalogItemId ? (
                                    <DataSourceProfile
                                        catalogId={ds.catalogItemId}
                                        context={{ wsId, dataSourceId: ds.id, ontologyId, ontologyName } satisfies DataSourceProfileContext}
                                        embedded
                                        onNavigate={onClose}
                                    />
                                ) : (
                                    <p className="text-sm text-ink-muted">This data source isn't linked to a catalog item.</p>
                                )
                            )}

                            {/* ─── Aggregation Tab ──────────────────────── */}
                            {activeTab === 'aggregation' && (
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between">
                                        <h6 className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider">
                                            Projection Mode
                                        </h6>
                                        {isDirty && (
                                            <span className="flex items-center gap-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                                                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                                                Unsaved
                                            </span>
                                        )}
                                    </div>

                                    <label className={cn(
                                        "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                                        pendingMode === '' ? "border-indigo-500/40 bg-indigo-500/[0.04]" : "border-glass-border hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                                    )}>
                                        <input type="radio" name={`proj-${ds.id}`} checked={pendingMode === ''}
                                            onChange={handleSelectInherit} className="mt-1 accent-indigo-500" />
                                        <div>
                                            <span className="text-sm font-medium text-ink">Inherit from Provider</span>
                                            <span className="inline-flex items-center gap-1 ml-2 px-1.5 py-0.5 text-[9px] font-bold rounded bg-emerald-500/10 text-emerald-500">DEFAULT</span>
                                            <p className="text-xs text-ink-muted mt-0.5">Uses the provider's default projection mode</p>
                                        </div>
                                    </label>

                                    <label className={cn(
                                        "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                                        pendingMode === 'in_source' ? "border-indigo-500/40 bg-indigo-500/[0.04]" : "border-glass-border hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                                    )}>
                                        <input type="radio" name={`proj-${ds.id}`} checked={pendingMode === 'in_source'}
                                            onChange={handleSelectInSource} className="mt-1 accent-indigo-500" />
                                        <div>
                                            <span className="text-sm font-medium text-ink">In Source</span>
                                            <p className="text-xs text-ink-muted mt-0.5">Store aggregated edges in the same graph</p>
                                        </div>
                                    </label>

                                    <label className={cn(
                                        "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                                        pendingMode === 'dedicated' ? "border-indigo-500/40 bg-indigo-500/[0.04]" : "border-glass-border hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                                    )}>
                                        <input type="radio" name={`proj-${ds.id}`} checked={pendingMode === 'dedicated'}
                                            onChange={handleSelectDedicated} className="mt-1 accent-indigo-500" />
                                        <div className="flex-1">
                                            <span className="text-sm font-medium text-ink">Dedicated Graph</span>
                                            <p className="text-xs text-ink-muted mt-0.5">Store in a separate projection graph for isolation</p>
                                            {pendingMode === 'dedicated' && (
                                                <div className="mt-3 animate-in slide-in-from-top-2 fade-in duration-200">
                                                    <label className="block text-[11px] font-medium text-ink-secondary mb-1">Dedicated Graph Name</label>
                                                    <input type="text" value={pendingDedicatedName}
                                                        onChange={e => setPendingDedicatedName(e.target.value)}
                                                        placeholder={`e.g. ${ds.label || ds.catalogItemId}_aggregated`}
                                                        onClick={e => e.stopPropagation()}
                                                        className="w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50" />
                                                </div>
                                            )}
                                        </div>
                                    </label>

                                    {isOverridden && !isDirty && (
                                        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600 dark:text-amber-400">
                                            <span className="font-semibold">&#x26A0; Override active</span>
                                            <span>— This data source is not using the provider default.</span>
                                        </div>
                                    )}

                                    {/* Mode-switch purge warning — shown when changing modes with existing aggregated edges */}
                                    {isDirty && pendingMode !== originalMode && ds.aggregationStatus === 'ready' && (
                                        <div className="p-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] animate-in slide-in-from-top-2 fade-in duration-200">
                                            <div className="flex items-start gap-2">
                                                <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                                                <div>
                                                    <p className="text-xs font-semibold text-amber-600 dark:text-amber-400">
                                                        Existing aggregated edges detected
                                                    </p>
                                                    <p className="text-[11px] text-amber-600/80 dark:text-amber-400/80 mt-0.5 leading-relaxed">
                                                        Switching projection modes will leave stale aggregated edges in the previous location.
                                                        After saving, purge the existing edges and then re-trigger aggregation to write them
                                                        to the new target.
                                                    </p>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Save / Discard bar — sticky feel, only when dirty */}
                                    {isDirty && canManageDs && (
                                        <div className="flex items-center justify-end gap-2 p-3 rounded-lg bg-amber-500/[0.06] border border-amber-500/20 animate-in slide-in-from-top-1 fade-in duration-150">
                                            <button
                                                onClick={handleDiscardConfig}
                                                disabled={isSaving}
                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                                            >
                                                <RotateCcw className="w-3 h-3" /> Discard
                                            </button>
                                            <button
                                                onClick={handleSaveConfig}
                                                disabled={isSaving || (pendingMode === 'dedicated' && !pendingDedicatedName.trim())}
                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors disabled:opacity-50 shadow-sm"
                                            >
                                                {isSaving
                                                    ? <Loader2 className="w-3 h-3 animate-spin" />
                                                    : <Save className="w-3 h-3" />}
                                                {isSaving ? 'Saving…' : 'Save Changes'}
                                            </button>
                                        </div>
                                    )}

                                    {canManageDs && (
                                        <div className="mt-4 pt-4 border-t border-glass-border space-y-2">
                                            <button onClick={onReaggregate} disabled={isDirty}
                                                title={isDirty ? 'Save your config changes before re-triggering aggregation.' : undefined}
                                                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 font-semibold text-sm hover:bg-indigo-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                                                <Settings2 className="w-4 h-4" /> Re-Trigger Aggregation
                                            </button>

                                            {ds.aggregationStatus === 'ready' && (
                                                !purgeConfirm ? (
                                                    <button onClick={() => setPurgeConfirm(true)}
                                                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-ink-muted hover:text-red-500 hover:bg-red-500/5 transition-colors">
                                                        <Trash2 className="w-4 h-4" /> Purge Aggregated Edges
                                                    </button>
                                                ) : (
                                                    <div className="p-3 rounded-lg border border-red-500/20 bg-red-500/5 space-y-2.5">
                                                        <div className="flex items-start gap-2">
                                                            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                                                            <p className="text-xs text-red-400 leading-relaxed">
                                                                This will remove all materialized aggregated edges and reset aggregation status. This cannot be undone.
                                                            </p>
                                                        </div>
                                                        <div className="flex justify-end gap-2">
                                                            <button onClick={() => setPurgeConfirm(false)} disabled={purgeLoading}
                                                                className="px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors">Cancel</button>
                                                            <button onClick={async () => { setPurgeLoading(true); try { await onPurge() } finally { setPurgeLoading(false); setPurgeConfirm(false) } }}
                                                                disabled={purgeLoading}
                                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50 shadow-sm shadow-red-500/25">
                                                                {purgeLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />} Confirm Purge
                                                            </button>
                                                        </div>
                                                    </div>
                                                )
                                            )}
                                        </div>
                                    )}

                                    <div className="mt-6 pt-4 border-t border-glass-border">
                                        <AggregationHistory dataSourceId={ds.id} />
                                    </div>
                                </div>
                            )}

                            {/* ─── Views Tab ────────────────────────────── */}
                            {activeTab === 'views' && (
                                <div>
                                    <div className="flex items-center justify-between mb-3">
                                        <h6 className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider">Associated Views</h6>
                                        <Link to={`/explorer?workspace=${wsId}&dataSource=${ds.id}`}
                                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-indigo-500 text-white text-[11px] font-semibold hover:bg-indigo-600 transition-colors shadow-sm">
                                            <Plus className="w-3 h-3" /> Create View
                                        </Link>
                                    </div>

                                    {views.length > 0 ? (
                                        <div className="space-y-2">
                                            {views.map(view => (
                                                <Link key={view.id} to={`/views/${view.id}`}
                                                    className="flex items-center justify-between p-3 rounded-lg border border-glass-border hover:border-indigo-500/20 hover:bg-indigo-500/[0.02] transition-colors duration-150 group/view">
                                                    <div className="flex items-center gap-3 min-w-0">
                                                        <div className="w-7 h-7 rounded-lg bg-cyan-500/10 text-cyan-500 flex items-center justify-center shrink-0">
                                                            <Eye className="w-3.5 h-3.5" />
                                                        </div>
                                                        <div className="min-w-0">
                                                            <span className="text-sm font-medium text-ink truncate block">{view.name}</span>
                                                            {view.description && <span className="text-[10px] text-ink-muted truncate block">{view.description}</span>}
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-2 shrink-0">
                                                        {view.layoutType && <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-black/5 dark:bg-white/5 text-ink-muted">{view.layoutType}</span>}
                                                        <ExternalLink className="w-3 h-3 text-ink-muted opacity-0 group-hover/view:opacity-100 transition-opacity" />
                                                    </div>
                                                </Link>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="py-8 text-center bg-black/[0.02] dark:bg-white/[0.02] rounded-xl border border-glass-border border-dashed">
                                            <Eye className="w-8 h-8 mx-auto mb-3 opacity-30 text-indigo-500" />
                                            <div className="text-sm font-semibold text-ink mb-1">No views yet</div>
                                            <div className="text-xs text-ink-muted mb-3">Views scoped to this data source will appear here.</div>
                                            <Link to={`/explorer?workspace=${wsId}&dataSource=${ds.id}`}
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500 text-white text-xs font-semibold hover:bg-indigo-600 transition-colors">
                                                <Compass className="w-3 h-3" /> Open Explorer
                                            </Link>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* ─── Versioning Tab ───────────────────────── */}
                            {activeTab === 'versioning' && (
                                <DataSourceVersioningTab wsId={wsId} dataSourceId={ds.id} />
                            )}
                            </>)}
                        </div>

                        {/* ── Footer action ──────────────────────────────── */}
                        <div className="px-6 py-4 border-t border-glass-border/50 shrink-0">
                            {/* Views are the payoff of a data source; the header
                                already has Schema Editor + Explorer, so the primary
                                footer CTA points at the views that consume it. */}
                            <Link to={`/workspaces/${wsId}/views`} onClick={onClose}
                                className={cn(
                                    'w-full inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3',
                                    'bg-gradient-to-r from-accent-lineage to-violet-600 text-white text-sm font-semibold',
                                    'shadow-lg shadow-accent-lineage/25 hover:shadow-xl hover:-translate-y-0.5',
                                    'transition-[transform,box-shadow] duration-200',
                                )}>
                                <Eye className="w-4 h-4" /> See all views
                            </Link>
                        </div>
                    </motion.aside>
                )}
            </AnimatePresence>
        </>
    )

    return createPortal(content, document.body)
}


// Permission-gated edit/delete buttons. Workspace data-source
// mutations need ``workspace:datasource:manage`` on the specific
// workspace; without it the buttons are hidden so a viewer doesn't
// click into a 403 toast.
function DataSourceActions({
    wsId, onEdit, onDelete,
}: {
    wsId: string
    onEdit: () => void
    onDelete?: () => void
}) {
    const isPlatformAdmin = usePermission('system:admin')
    const canManage = isPlatformAdmin || usePermission('workspace:datasource:manage', wsId)
    if (!canManage) return null
    return (
        <>
            <button onClick={onEdit} className="p-2 rounded-lg text-ink-muted hover:text-indigo-500 hover:bg-indigo-500/10 transition-colors" title="Edit">
                <Edit2 className="w-3.5 h-3.5" />
            </button>
            {onDelete && (
                <button onClick={onDelete} className="p-2 rounded-lg text-ink-muted hover:text-red-500 hover:bg-red-500/10 transition-colors" title="Remove">
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            )}
        </>
    )
}
