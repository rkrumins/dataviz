/**
 * DataSourceDetailPanel — slide-in drawer for data source details.
 * Renders as a right-side panel via portal (same pattern as ExplorerPreviewDrawer).
 * Tabs: Insights · Aggregation · Views
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { MOTION } from '@/lib/motion'
import {
    Database, Edit2, Trash2, X, ExternalLink, Settings2, Plus, Eye,
    BarChart3, AlertTriangle, Loader2, Boxes,
    GitBranch, Star, Clock, Compass, Save, RotateCcw,
} from 'lucide-react'
import { NodeIdentityField, NodeIdentityBadge } from '@/components/dataSource/NodeIdentity'
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
import { useFeature } from '@/store/features'
import { DataSourceVersioningTab } from '@/features/versioning/components/DataSourceVersioningTab'
import { VocabAlignmentWarning } from './VocabAlignmentWarning'
import { PropertyMappingTab } from './PropertyMappingTab'
import { DataSourceActionMenu } from './DataSourceActionMenu'
import type { DataSourceProviderInfo } from './useWorkspaceDetailData'
import { DataSourceProfile, type DataSourceProfileContext } from '@/components/insights/DataSourceProfile'

// ─────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────

export interface AggregationConfigSnapshot {
    projectionMode: string
    dedicatedGraphName: string
    /** URN-equivalent node-identity property. "urn" is the default. */
    identityProperty: string
    /** Node display-name property. "name" is the default. */
    nameProperty: string
}

/** Tabs the panel can open on. Also the accepted ``?dsTab=`` values. */
export type DataSourceTab =
    'insights' | 'mapping' | 'aggregation' | 'views' | 'versioning'

const DS_TABS: readonly DataSourceTab[] = [
    'insights', 'mapping', 'aggregation', 'views', 'versioning',
]

interface DataSourceDetailPanelProps {
    ds: DataSourceResponse | null
    wsId: string
    isOpen: boolean
    /** Tab to open on, from ``?dsTab=``. Ignored when unrecognised, so a
     *  stale or hand-edited link degrades to Overview rather than a blank
     *  panel. */
    initialTab?: string
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
    /** Offboard — reversible; moves the source to Recently deleted. */
    onDelete?: () => void
    /** Delete permanently — irreversible; only the guarded direct path offers it. */
    onDeletePermanent?: () => void
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
    initialTab,
    providerInfo,
    ontologyName,
    ontologyId,
    views,
    readiness,
    ontologies,
    onSaveEdit,
    onDelete,
    onDeletePermanent,
    onReaggregate,
    onPurge,
    onSaveAggregationConfig,
    onClose,
}: DataSourceDetailPanelProps) {
    const requestedTab = DS_TABS.includes(initialTab as DataSourceTab)
        ? (initialTab as DataSourceTab)
        : undefined
    const [activeTab, setActiveTab] = useState<DataSourceTab>(
        requestedTab ?? 'insights',
    )
    // Re-apply when the link changes or the panel is pointed at a different
    // source — but never on every render, or it would override the user's own
    // tab clicks for as long as the param sits in the URL.
    useEffect(() => {
        if (requestedTab) setActiveTab(requestedTab)
    }, [requestedTab, ds?.id])
    const versioningEnabled = useFeature('versioningEnabled')
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
    // Node-identity property (URN-equivalent). Server always echoes "urn" by
    // default, so a missing value on legacy responses folds to "urn" too.
    const originalIdentityProperty = ds?.identityProperty || 'urn'
    const originalNameProperty = ds?.nameProperty || 'name'
    const [pendingMode, setPendingMode] = useState(originalMode)
    const [pendingDedicatedName, setPendingDedicatedName] = useState(originalDedicatedName)
    const [pendingIdentityProperty, setPendingIdentityProperty] = useState(originalIdentityProperty)
    const [pendingNameProperty, setPendingNameProperty] = useState(originalNameProperty)
    const [isSaving, setIsSaving] = useState(false)

    // Reset pending state whenever the drawer points at a different DS, or when
    // a reload has brought fresh server values (originals) for the same DS.
    useEffect(() => {
        setPendingMode(originalMode)
        setPendingDedicatedName(originalDedicatedName)
        setPendingIdentityProperty(originalIdentityProperty)
        setPendingNameProperty(originalNameProperty)
        setIsSaving(false)
    }, [ds?.id, originalMode, originalDedicatedName, originalIdentityProperty, originalNameProperty])

    // Normalise for comparison/save: trim, and treat empty as the default.
    const normalizedIdentityProperty = pendingIdentityProperty.trim() || 'urn'
    const normalizedNameProperty = pendingNameProperty.trim() || 'name'
    const isDirty =
        pendingMode !== originalMode ||
        pendingDedicatedName !== originalDedicatedName ||
        normalizedIdentityProperty !== originalIdentityProperty ||
        normalizedNameProperty !== originalNameProperty
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
                { projectionMode: pendingMode, dedicatedGraphName: pendingDedicatedName, identityProperty: normalizedIdentityProperty, nameProperty: normalizedNameProperty },
                { projectionMode: originalMode, dedicatedGraphName: originalDedicatedName, identityProperty: originalIdentityProperty, nameProperty: originalNameProperty },
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
        setPendingIdentityProperty(originalIdentityProperty)
        setPendingNameProperty(originalNameProperty)
    }

    // Last-aggregated timestamp prefers the live readiness over the persisted
    // ds field so the header meta agrees with the Overview's Aggregation card.
    const liveLastAggregatedAt = readiness?.lastAggregatedAt ?? ds?.lastAggregatedAt

    const content = (
        <>
            {/* Backdrop — plain CSS transition, never inside AnimatePresence (fixes the
                StrictMode click-shield where a stranded fixed-inset-0 node eats clicks). */}
            <Backdrop open={!!(isOpen && ds)} onClick={onClose} zClassName="z-[60]" />

            {/* No AnimatePresence: this portaled popover unmounts instantly on close so an interrupted exit can't strand an invisible click-blocker over the page. It still animates in. */}
            <>
                {isOpen && ds && (
                    <motion.aside
                        key="data-source-detail-drawer"
                        className={cn(
                            'fixed right-0 top-0 h-full w-full max-w-2xl z-[61]',
                            'bg-canvas border-l border-glass-border',
                            'flex flex-col shadow-lg',
                        )}
                        initial={{ x: 480 }}
                        animate={{ x: 0 }}
                        transition={MOTION.drawerSlide}
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
                                <span className={cn("flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-full border",
                                    ds.isActive
                                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
                                        : 'bg-black/5 dark:bg-white/5 text-ink-muted border-glass-border'
                                )}>
                                    <span className={cn("w-2 h-2 rounded-full", ds.isActive ? 'bg-emerald-500' : 'bg-gray-400')} />
                                    {ds.isActive ? 'Active' : 'Inactive'}
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
                                <NodeIdentityBadge value={ds.identityProperty} />
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
                                    onDeletePermanent={onDeletePermanent}
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
                            <TabBtn active={activeTab === 'mapping'} icon={Boxes} label="Mapping" onClick={() => setActiveTab('mapping')} />
                            <TabBtn active={activeTab === 'aggregation'} icon={Settings2} label="Aggregation" onClick={() => setActiveTab('aggregation')} />
                            <TabBtn active={activeTab === 'views'} icon={Eye} label="Views" count={views.length} onClick={() => setActiveTab('views')} />
                            {versioningEnabled && (
                                <TabBtn active={activeTab === 'versioning'} icon={GitBranch} label="Versioning" onClick={() => setActiveTab('versioning')} />
                            )}
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
                                        context={{ wsId, dataSourceId: ds.id, ontologyId, ontologyName, identityProperty: ds.identityProperty, nameProperty: ds.nameProperty } satisfies DataSourceProfileContext}
                                        embedded
                                        onNavigate={onClose}
                                        onOpenMapping={() => setActiveTab('mapping')}
                                    />
                                ) : (
                                    <p className="text-sm text-ink-muted">This data source isn't linked to a catalog item.</p>
                                )
                            )}

                            {/* ─── Mapping Tab ──────────────────────────── */}
                            {/* Everything about how this source's PHYSICAL nodes map onto the
                                platform's model: which field is identity, which is the display
                                name, and where the properties actually live. */}
                            {activeTab === 'mapping' && (
                                <div className="space-y-6">
                                    <NodeIdentityField
                                        key={ds.id}
                                        value={pendingIdentityProperty}
                                        onChange={setPendingIdentityProperty}
                                        canEdit={canManageDs}
                                        providerId={ds.providerId}
                                        graphName={ds.graphName}
                                        nameValue={pendingNameProperty}
                                        onNameChange={setPendingNameProperty}
                                    />

                                    {/* Identity/name save through the Aggregation transaction
                                        (they're columns on the DS row); the property mapping
                                        saves itself (it merges into extra_config server-side).
                                        Two stores, one screen — so surface the pending identity
                                        edit here rather than stranding it on another tab. */}
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
                                                disabled={isSaving}
                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors disabled:opacity-50 shadow-sm"
                                            >
                                                {isSaving
                                                    ? <Loader2 className="w-3 h-3 animate-spin" />
                                                    : <Save className="w-3 h-3" />}
                                                {isSaving ? 'Saving…' : 'Save Identity'}
                                            </button>
                                        </div>
                                    )}

                                    <div className="pt-2 border-t border-glass-border">
                                        <PropertyMappingTab
                                            wsId={wsId}
                                            dataSourceId={ds.id}
                                            canEdit={canManageDs}
                                        />
                                    </div>
                                </div>
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

                                    {/* Node identity / display-name mapping moved to the Mapping
                                        tab — it is physical-to-logical mapping, not aggregation
                                        topology, and belongs with the property mapping so an
                                        operator sees one coherent story. */}

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
                            {versioningEnabled && activeTab === 'versioning' && (
                                <DataSourceVersioningTab wsId={wsId} dataSourceId={ds.id} />
                            )}
                            </>)}
                        </div>

                        {/* ── Footer action ──────────────────────────────── */}
                        <div className="px-6 py-4 border-t border-glass-border/50 shrink-0">
                            {/* Views are the payoff of a data source; the primary
                                footer CTA opens the Explorer pre-filtered to this
                                source so the user browses exactly its views. */}
                            <Link to={`/explorer?workspace=${wsId}&dataSource=${ds.id}`} onClick={onClose}
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
            </>
        </>
    )

    return createPortal(content, document.body)
}


// Permission-gated edit/delete buttons. Workspace data-source
// mutations need ``workspace:datasource:manage`` on the specific
// workspace; without it the buttons are hidden so a viewer doesn't
// click into a 403 toast.
function DataSourceActions({
    wsId, onEdit, onDelete, onDeletePermanent,
}: {
    wsId: string
    onEdit: () => void
    /** Offboard (reversible). */
    onDelete?: () => void
    /** Delete permanently (irreversible). */
    onDeletePermanent?: () => void
}) {
    const isPlatformAdmin = usePermission('system:admin')
    const canManage = isPlatformAdmin || usePermission('workspace:datasource:manage', wsId)
    if (!canManage) return null
    return (
        <>
            <button onClick={onEdit} className="p-2 rounded-lg text-ink-muted hover:text-indigo-500 hover:bg-indigo-500/10 transition-colors" title="Edit">
                <Edit2 className="w-3.5 h-3.5" />
            </button>
            {onDelete && onDeletePermanent && (
                <DataSourceActionMenu
                    align="right"
                    onOffboard={onDelete}
                    onDelete={onDeletePermanent}
                />
            )}
        </>
    )
}
