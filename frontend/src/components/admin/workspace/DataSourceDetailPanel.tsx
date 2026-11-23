/**
 * DataSourceDetailPanel — slide-in drawer for data source details.
 * Renders as a right-side panel via portal (same pattern as ExplorerPreviewDrawer).
 * Tabs: Insights · Aggregation · Views (· Questions · Activity · Versioning, by switch)
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { MOTION } from '@/lib/motion'
import {
    Database, Edit2, Trash2, X, ExternalLink, Settings2, Plus, Eye,
    BarChart3, AlertTriangle, Loader2,
    GitBranch, Star, Clock, Compass, Save, RotateCcw, LineChart, MessageCircleQuestion, History,
} from 'lucide-react'
import { NodeIdentityField, NodeIdentityBadge } from '@/components/dataSource/NodeIdentity'
import { cn } from '@/lib/utils'
import { viewTypeLabel } from '@/lib/viewUtils'
import { Backdrop } from '@/components/ui/Backdrop'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { SourceProfiling } from '@/components/ingestion/profiling/SourceProfiling'
import type { DataSourceResponse } from '@/services/workspaceService'
import type { DataSourceStats } from '@/hooks/useDashboardData'
import type { View } from '@/services/viewApiService'

/** Tab ids, in the order they appear. Hoisted so the URL parser and the
 *  buttons cannot drift apart. */
const DATA_SOURCE_TABS = ['insights', 'profiling', 'aggregation', 'views', 'questions', 'activity', 'versioning'] as const
type DataSourceTab = (typeof DATA_SOURCE_TABS)[number]
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { DataSourceReadinessResponse } from '@/services/aggregationService'
import { AggregationHistory } from '../AggregationHistory'
import { getProviderLogo } from '../ProviderLogos'
import { usePermission } from '@/store/auth'
import { usePersonaMode } from '@/store/persona'
import { useFeature } from '@/store/features'
import { DataSourceVersioningTab } from '@/features/versioning/components/DataSourceVersioningTab'
import { VocabAlignmentWarning } from './VocabAlignmentWarning'
import { FinishImportingViewsBanner } from '@/features/view-transfer/FinishImportingViewsBanner'
import { DataSourceActionMenu } from './DataSourceActionMenu'
import { DataSourceLifecycle, MovedFromChip } from '@/features/data-source-transfer/DataSourceLifecycle'
import type { DataSourceProviderInfo } from './useWorkspaceDetailData'
import { DataSourceProfile, type DataSourceProfileContext } from '@/components/insights/DataSourceProfile'
import { DataContactsCard } from './DataContactsCard'
import { AboutDataSourceCard } from './AboutDataSourceCard'
import { DataSourceActivity } from './DataSourceActivity'
import { TrustBadges } from '@/components/dataSource/TrustBadges'
import { DATA_SOURCE_METADATA_FEATURE } from '@/services/dataSourceMetadataService'
import { DiscussionPanel } from '@/features/discussions/DiscussionPanel'
import { ThreadView } from '@/features/discussions/ThreadView'
import { WatchButton } from '@/features/discussions/DiscussionsDrawer'
import { useSubjectSummary } from '@/features/discussions/useDiscussions'

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
    /** Offboard — reversible; moves the source to Recently deleted. */
    onDelete?: () => void
    /** Delete permanently — irreversible; only the guarded direct path offers it. */
    onDeletePermanent?: () => void
    /** Move it, with its views, to another workspace. Offered to whoever may. */
    onMove?: () => void
    /** The source moved away from here (an undo) — the page refreshes. */
    onMovedAway?: () => void
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
    /** Tags already used in this workspace, most used first — offered when tagging this one. */
    tagSuggestions?: string[]
    /** Shows the workspace's data requests (where the one this source came from is listed). */
    onShowDataRequests?: () => void
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────

/** One of the drawer's tabs: its icon, label and, when there is one, a count. */
function DrawerTab({ value, icon, label, count }: {
    value: DataSourceTab
    icon: React.ComponentType<{ className?: string }>
    label: string
    count?: number
}) {
    return (
        <TabsTrigger value={value} icon={icon} className="h-11 px-2.5 text-xs sm:text-[13px]"
            badge={count !== undefined && count > 0 ? (
                <span className="rounded-full bg-black/[0.05] px-1.5 text-[10px] font-bold leading-4 text-ink-muted tabular-nums dark:bg-white/[0.07]">
                    {count}
                </span>
            ) : undefined}>
            {label}
        </TabsTrigger>
    )
}

// ─────────────────────────────────────────────────────────────────────
// DataSourceDetailPanel (Drawer)
// ─────────────────────────────────────────────────────────────────────

export function DataSourceDetailPanel({
    ds,
    wsId,
    isOpen,
    stats,
    providerInfo,
    ontologyName,
    ontologyId,
    views,
    readiness,
    ontologies,
    onSaveEdit,
    onDelete,
    onDeletePermanent,
    onMove,
    onMovedAway,
    onReaggregate,
    onPurge,
    onSaveAggregationConfig,
    onClose,
    tagSuggestions,
    onShowDataRequests,
}: DataSourceDetailPanelProps) {
    /**
     * Tab state lives in the URL, not in `useState`.
     *
     * A notification about a source's profile has to be able to land ON the
     * profile, and a link someone pastes to a colleague has to open what they
     * were looking at. Local state made both impossible, and it is why the
     * profiling surface needed a separate routable page in the first place —
     * a page whose back button could then only ever guess where you came from.
     */
    const [searchParams, setSearchParams] = useSearchParams()
    const conversations = useFeature('conversationsEnabled')
    const details = useFeature(DATA_SOURCE_METADATA_FEATURE)
    const rawTab = searchParams.get('dstab')
    const activeTab: DataSourceTab = DATA_SOURCE_TABS.includes(rawTab as DataSourceTab)
        && (rawTab !== 'questions' || conversations) && (rawTab !== 'activity' || details)
        ? (rawTab as DataSourceTab)
        : 'insights'
    const setActiveTab = (next: DataSourceTab) => {
        const merged = new URLSearchParams(searchParams)
        // 'insights' is the default and writes no param, so the common URL
        // stays clean and a stale param cannot outlive the drawer.
        if (next === 'insights') merged.delete('dstab')
        else merged.set('dstab', next)
        // The open question belongs to the Questions tab (a notification links to it there).
        if (next !== 'questions') { merged.delete('discussion'); merged.delete('message') }
        setSearchParams(merged, { replace: true })
    }
    // Questions about this data: a thread opens in the tab itself, kept in the URL.
    const dsSubject = ds ? { type: 'data_source' as const, id: ds.id, name: ds.label || ds.graphName || ds.catalogItemId } : null
    const questions = useSubjectSummary(conversations ? dsSubject : null).data
    const openThreadId = activeTab === 'questions' ? searchParams.get('discussion') : null
    const [askOpen, setAskOpen] = useState(false)
    const showThread = (id: string | null) => {
        const merged = new URLSearchParams(searchParams)
        merged.set('dstab', 'questions')
        if (id) merged.set('discussion', id); else merged.delete('discussion')
        merged.delete('message')
        setSearchParams(merged, { replace: true })
    }
    const versioningEnabled = useFeature('versioningEnabled')
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
    const canEditModel = usePermission('workspace:ontology:manage', wsId)
    const technical = usePersonaMode() === 'technical'

    // ── Aggregation tab: pending edits live entirely in local state until the
    //    user clicks Save. This avoids per-keystroke API calls and full-page
    //    reloads that would unmount this drawer mid-interaction.
    const originalMode = ds?.projectionMode ?? ''
    const originalDedicatedName = ds?.dedicatedGraphName ?? ''
    // The mapping in FORCE for this source — resolved server-side across all
    // four scopes, so it may have been inherited rather than set here. The
    // panel shows what applies; `identityPropertySource` says where it came
    // from, and the field renders the difference.
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

    // Trim only. Empty must stay empty: it is how "stop overriding, inherit
    // again" is expressed, and the API stores it as NULL so the source falls
    // through to its provider / workspace / the platform default. Folding it to
    // 'urn' here would send an explicit default instead, pinning the source to
    // it forever — the one edit the inherit chain makes it impossible to undo.
    const normalizedIdentityProperty = pendingIdentityProperty.trim()
    const normalizedNameProperty = pendingNameProperty.trim()
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
                            'fixed inset-y-0 right-0 w-full max-w-2xl z-[61]',
                            'bg-canvas border-l border-glass-border',
                            'flex flex-col shadow-lg',
                        )}
                        initial={{ x: 480 }}
                        animate={{ x: 0 }}
                        transition={MOTION.drawerSlide}
                    >
                        {/* ── Header ─────────────────────────────────────── */}
                        <div className="px-4 sm:px-6 pt-5 sm:pt-6 pb-4 border-b border-glass-border/50 shrink-0">
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
                                {details && <TrustBadges trustStatus={ds.trustStatus} classification={ds.classification} size="md" />}
                                {ontologyName && (
                                    <Link
                                        to={ontologyId ? `/schema/${ontologyId}` : '/schema'}
                                        title={ontologyName}
                                        className="inline-flex min-w-0 max-w-full items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20 hover:bg-violet-500/20 transition-colors"
                                    >
                                        <GitBranch className="w-3 h-3 shrink-0" aria-hidden /> <span className="truncate">{ontologyName}</span>
                                    </Link>
                                )}
                                {liveLastAggregatedAt && (
                                    <span className="flex items-center gap-1 whitespace-nowrap text-[10px] text-ink-muted">
                                        <Clock className="w-3 h-3 shrink-0" aria-hidden /> Connections refreshed {new Date(liveLastAggregatedAt).toLocaleDateString()}
                                    </span>
                                )}
                                {technical && <NodeIdentityBadge value={ds.identityProperty} />}
                                <MovedFromChip wsId={wsId} dataSourceId={ds.id} />
                            </div>

                            {/* Quick action buttons */}
                            <div className="flex flex-wrap items-center gap-2">
                                {/* What a source is for is its views — that is the way in. Editing its
                                    data model is for the people who manage the model. */}
                                <Link
                                    to={`/explorer?workspace=${wsId}&dataSource=${ds.id}`}
                                    className="flex items-center gap-1.5 whitespace-nowrap px-3 py-2 rounded-lg bg-indigo-500 text-white text-[11px] font-semibold hover:bg-indigo-600 transition-colors"
                                >
                                    <Compass className="w-3 h-3 shrink-0" aria-hidden /> Explore views
                                </Link>
                                {canEditModel && (
                                    <Link
                                        to={`/schema?workspaceId=${wsId}&dataSourceId=${ds.id}`}
                                        className="flex items-center gap-1.5 whitespace-nowrap px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-glass-border text-[11px] font-semibold text-ink hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                                    >
                                        <ExternalLink className="w-3 h-3 shrink-0" aria-hidden /> Edit data model
                                    </Link>
                                )}
                                <div className="ml-auto flex shrink-0 items-center gap-1" data-testid="ds-actions-end">
                                    {conversations && dsSubject && <WatchButton subject={dsSubject} />}
                                    <DataSourceActions
                                        wsId={wsId}
                                        onEdit={startEditing}
                                        onDelete={onDelete}
                                        onDeletePermanent={onDeletePermanent}
                                        onMove={onMove}
                                    />
                                </div>
                                {/* DataSourceActions handles permission gating per
                                    workspace; falls back to hidden buttons if the
                                    viewer can't manage data sources here. */}
                            </div>
                        </div>

                        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as DataSourceTab)}
                            className="flex min-h-0 flex-1 flex-col">
                        {/* ── Tab Bar: every tab keeps its size; on a narrow drawer the strip scrolls ── */}
                        {!editing && (
                        <TabsList look="underline" scrollable aria-label="About this data source"
                            className="shrink-0 gap-1 border-glass-border/40 px-4 sm:px-6">
                            <DrawerTab value="insights" icon={BarChart3} label="Overview" />
                            <DrawerTab value="aggregation" icon={Settings2} label="Processing" />
                            <DrawerTab value="profiling" icon={LineChart} label="Trends" />
                            <DrawerTab value="views" icon={Eye} label="Views" count={views.length} />
                            {conversations && (
                                <DrawerTab value="questions" icon={MessageCircleQuestion} label="Questions" count={questions?.open} />
                            )}
                            {details && <DrawerTab value="activity" icon={History} label="Activity" />}
                            {versioningEnabled && <DrawerTab value="versioning" icon={GitBranch} label="Versioning" />}
                        </TabsList>
                        )}

                        {/* ── Content (scrollable): inline edit OR the active tab ── */}
                        <div className="flex-1 overflow-y-auto custom-scrollbar px-4 sm:px-6 py-5">
                            {/* What needs attention first, above the tab and scrolling with it, so it
                                never squeezes the tab away: vocabulary drift, views still to import,
                                and where the source has lived (a request waiting, a move to undo). */}
                            {!editing && (
                                <div className="mb-5 space-y-3 empty:hidden">
                                    <VocabAlignmentWarning wsId={wsId} dataSourceId={ds.id} className="" />
                                    <FinishImportingViewsBanner wsId={wsId} dataSourceId={ds.id} viewCount={views.length} />
                                    <DataSourceLifecycle wsId={wsId} dataSourceId={ds.id} onChanged={onMovedAway} />
                                </div>
                            )}
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
                            ) : (<TabsContent value={activeTab}>
                            {/* ─── Insights Tab ─────────────────────────── */}
                            {activeTab === 'insights' && (<div className="space-y-5">
                                <AboutDataSourceCard key={ds.id} wsId={wsId} dsId={ds.id} tagSuggestions={tagSuggestions} onShowRequests={onShowDataRequests} />
                                <DataContactsCard wsId={wsId} dsId={ds.id} onAsk={() => { setAskOpen(true); showThread(null) }} />
                                {ds.catalogItemId ? (
                                    <DataSourceProfile
                                        catalogId={ds.catalogItemId}
                                        context={{ wsId, dataSourceId: ds.id, ontologyId, ontologyName, identityProperty: ds.identityProperty, nameProperty: ds.nameProperty } satisfies DataSourceProfileContext}
                                        embedded
                                        onNavigate={onClose}
                                    />
                                ) : (
                                    <p className="text-sm text-ink-muted">This data source isn't linked to a catalog item.</p>
                                )}
                            </div>)}

                            {/* ─── Questions Tab ────────────────────────── */}
                            {activeTab === 'questions' && dsSubject && (
                                openThreadId ? (
                                    <ThreadView key={openThreadId} threadId={openThreadId} focusMessageId={searchParams.get('message')}
                                        onBack={() => showThread(null)} onDeleted={() => showThread(null)} className="-mx-4 sm:-mx-6 -my-5" />
                                ) : (
                                    <DiscussionPanel subject={dsSubject} onOpenThread={showThread}
                                        compose={askOpen} onComposeChange={setAskOpen} />
                                )
                            )}

                            {/* ─── Activity Tab ─────────────────────────── */}
                            {activeTab === 'activity' && <DataSourceActivity wsId={wsId} dsId={ds.id} />}

                            {/* ─── Profiling Tab ────────────────────────── */}
                            {activeTab === 'profiling' && (
                                <SourceProfiling
                                    dataSourceId={ds.id}
                                    sourceName={ds.label || ds.graphName || undefined}
                                />
                            )}

                            {/* ─── Aggregation Tab ──────────────────────── */}
                            {activeTab === 'aggregation' && (
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between">
                                        <h6 className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider">
                                            Where connections are kept
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
                                            onChange={handleSelectInherit} disabled={!canManageDs} className="mt-1 accent-indigo-500" />
                                        <div>
                                            <span className="text-sm font-medium text-ink">The usual place</span>
                                            <span className="inline-flex items-center gap-1 ml-2 px-1.5 py-0.5 text-[9px] font-bold rounded bg-emerald-500/10 text-emerald-500">DEFAULT</span>
                                            <p className="text-xs text-ink-muted mt-0.5">Whatever this source’s provider does by default · inherit</p>
                                        </div>
                                    </label>

                                    <label className={cn(
                                        "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                                        pendingMode === 'in_source' ? "border-indigo-500/40 bg-indigo-500/[0.04]" : "border-glass-border hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                                    )}>
                                        <input type="radio" name={`proj-${ds.id}`} checked={pendingMode === 'in_source'}
                                            onChange={handleSelectInSource} disabled={!canManageDs} className="mt-1 accent-indigo-500" />
                                        <div>
                                            <span className="text-sm font-medium text-ink">With the data</span>
                                            <p className="text-xs text-ink-muted mt-0.5">Kept in the same graph as the data · in source</p>
                                        </div>
                                    </label>

                                    <label className={cn(
                                        "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                                        pendingMode === 'dedicated' ? "border-indigo-500/40 bg-indigo-500/[0.04]" : "border-glass-border hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                                    )}>
                                        <input type="radio" name={`proj-${ds.id}`} checked={pendingMode === 'dedicated'}
                                            onChange={handleSelectDedicated} disabled={!canManageDs} className="mt-1 accent-indigo-500" />
                                        <div className="flex-1">
                                            <span className="text-sm font-medium text-ink">In a graph of their own</span>
                                            <p className="text-xs text-ink-muted mt-0.5">A separate graph, kept apart from the data · dedicated</p>
                                            {pendingMode === 'dedicated' && (
                                                <div className="mt-3 animate-in slide-in-from-top-2 fade-in duration-200">
                                                    <label className="block text-[11px] font-medium text-ink-secondary mb-1">Name of that graph</label>
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

                                    {/* Node Identity Property (URN-equivalent) — shared control,
                                        graph-aware suggestions from the source's own node properties. */}
                                    <NodeIdentityField
                                        key={ds.id}
                                        value={pendingIdentityProperty}
                                        onChange={setPendingIdentityProperty}
                                        canEdit={canManageDs}
                                        providerId={ds.providerId}
                                        graphName={ds.graphName}
                                        nameValue={pendingNameProperty}
                                        onNameChange={setPendingNameProperty}
                                        identitySource={ds.identityPropertySource}
                                        nameSource={ds.namePropertySource}
                                    />

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

                                            {/* The page asks to confirm (and why) before purging. */}
                                            {ds.aggregationStatus === 'ready' && (
                                                <button
                                                    onClick={async () => {
                                                        setPurgeLoading(true)
                                                        // A failure has already been reported by the page.
                                                        try { await onPurge() } catch { /* reported */ } finally { setPurgeLoading(false) }
                                                    }}
                                                    disabled={purgeLoading}
                                                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-ink-muted hover:text-red-500 hover:bg-red-500/5 transition-colors disabled:opacity-50">
                                                    {purgeLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Purge Aggregated Edges
                                                </button>
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
                                                        {view.layoutType && <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-black/5 dark:bg-white/5 text-ink-muted">{viewTypeLabel(view.layoutType)}</span>}
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
                                <DataSourceVersioningTab
                                    wsId={wsId}
                                    dataSourceId={ds.id}
                                    label={ds.label}
                                    // A cold stats cache reads 0 / stale: no size beats a wrong one.
                                    itemCount={stats && !stats.computing ? stats.nodeCount + stats.edgeCount : null}
                                />
                            )}
                            </TabsContent>)}
                        </div>
                        </Tabs>

                        {/* ── Footer action ──────────────────────────────── */}
                        <div className="px-4 sm:px-6 py-3 sm:py-4 border-t border-glass-border/50 shrink-0">
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
// click into a 403 notification.
function DataSourceActions({
    wsId, onEdit, onDelete, onDeletePermanent, onMove,
}: {
    wsId: string
    onEdit: () => void
    /** Offboard (reversible). */
    onDelete?: () => void
    /** Delete permanently (irreversible). */
    onDeletePermanent?: () => void
    /** Move to another workspace — not tied to deleting being allowed. */
    onMove?: () => void
}) {
    const isPlatformAdmin = usePermission('system:admin')
    const canManage = isPlatformAdmin || usePermission('workspace:datasource:manage', wsId)
    if (!canManage) return null
    return (
        <>
            <button onClick={onEdit} className="p-2 rounded-lg text-ink-muted hover:text-indigo-500 hover:bg-indigo-500/10 transition-colors" title="Edit">
                <Edit2 className="w-3.5 h-3.5" />
            </button>
            {((onDelete && onDeletePermanent) || onMove) && (
                <DataSourceActionMenu
                    align="right"
                    onOffboard={onDelete && onDeletePermanent ? onDelete : undefined}
                    onDelete={onDelete && onDeletePermanent ? onDeletePermanent : undefined}
                    onMove={onMove}
                />
            )}
        </>
    )
}
