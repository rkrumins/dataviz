/**
 * WorkspaceDetailPage — single workspace detail view at /workspaces/:wsId.
 * Modern tabbed dashboard with hero header, data source grid, views,
 * aggregation, and ontology sections.
 */
import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import {
    ChevronLeft, Plus, Database, Loader2, Settings2,
    GitBranch, Eye, Info, Compass, HelpCircle, RefreshCw,
    Users, ShieldOff, Send, GitPullRequestArrow,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { WorkspaceReviewsInbox } from '@/features/reviews/components/WorkspaceReviewsInbox'
import { workspaceService, type DataSourceResponse } from '@/services/workspaceService'
import { DangerConfirmDialog } from '@/components/ui/DangerConfirmDialog'
import {
    useDataSourceDeletion, impactSections, deleteCaveat,
} from '@/components/admin/workspace/useDataSourceDeletion'
import { DeletedDataSources } from '@/components/admin/workspace/DeletedDataSources'
import { aggregationService } from '@/services/aggregationService'
import { useToast } from '@/components/ui/toast'
import { usePermission, usePermissionClaims } from '@/store/auth'
import { useFeature } from '@/store/features'
import { accessRequestsService } from '@/services/accessRequestsService'
import { AddDataSourceWizard } from '@/components/admin/workspace/AddDataSourceWizard'
import { useWorkspaceDetailData } from '@/components/admin/workspace/useWorkspaceDetailData'
import { WorkspaceHeroHeader } from '@/components/admin/workspace/WorkspaceHeroHeader'
import { DataSourceGridCard } from '@/components/admin/workspace/DataSourceGridCard'
import { WorkspaceCardSkeleton } from '@/components/admin/workspace/WorkspaceCardSkeleton'
import { DataSourceDetailPanel } from '@/components/admin/workspace/DataSourceDetailPanel'
import WorkspaceViewsSection from '@/components/admin/workspace/WorkspaceViewsSection'
import { WorkspaceAggregationDashboard } from '@/components/admin/workspace/WorkspaceAggregationDashboard'
import { WorkspaceOntologyTimeline } from '@/components/admin/workspace/WorkspaceOntologyTimeline'
import { WorkspaceMembers } from '@/components/workspaces/WorkspaceMembers'
import { PageContainer } from '@/components/layout/PageContainer'

// ─────────────────────────────────────────────────────────────────────
// WorkspaceDetailPage
// ─────────────────────────────────────────────────────────────────────

export function WorkspaceDetailPage() {
    const { wsId } = useParams<{ wsId: string }>()
    const navigate = useNavigate()
    const { showToast } = useToast()

    // ── Data fetching via custom hook ──────────────────────
    const {
        workspace, catalogItems, providers, ontologies, ontologyMap, dsStatsMap, dsProviderMap,
        viewsByDs, allWorkspaceViews, readinessMap, healthStatus,
        aggregateStats, isLoading, isRefreshing, reload
    } = useWorkspaceDetailData(wsId)

    // Track whether the workspace was ever loaded successfully for
    // this session, so we can distinguish "access revoked while open"
    // from "never existed / URL typo" in the no-workspace branch
    // below. Reset when navigating to a different wsId.
    const hadAccessRef = useRef(false)
    const claims = usePermissionClaims()
    useEffect(() => {
        if (workspace?.id === wsId) hadAccessRef.current = true
    }, [workspace, wsId])
    useEffect(() => {
        hadAccessRef.current = false
    }, [wsId])

    // ── Edit header state ──────────────────────────────────
    const [editingHeader, setEditingHeader] = useState(false)
    const [editName, setEditName] = useState('')
    const [editDesc, setEditDesc] = useState('')

    // ── Add DS wizard state ────────────────────────────────
    const [showAddDs, setShowAddDs] = useState(false)

    // ── Delete confirm state ───────────────────────────────

    // ── Edit DS modal state ────────────────────────────────

    // ── Selection + tab state ──────────────────────────────
    const [selectedDsId, setSelectedDsId] = useState<string | null>(null)
    const [searchParams, setSearchParams] = useSearchParams()
    // Pick up ``?tab=members`` (and friends) so other pages can deep
    // link straight to a specific tab — used by the WorkspacesPage
    // "Members" shortcut.
    const tabParam = searchParams.get('tab') as
        | 'sources' | 'views' | 'aggregation' | 'ontology' | 'reviews' | 'members' | null
    const [activeSection, setActiveSection] = useState<'sources' | 'views' | 'aggregation' | 'ontology' | 'reviews' | 'members'>(
        tabParam ?? 'sources',
    )
    // Reviews are a versioning surface; the tab (and a ?tab=reviews deep link)
    // disappears when the admin turns version control off.
    const versioningEnabled = useFeature('versioningEnabled')

    // Workspace admin permission gates the Members tab. The store's
    // `usePermission` re-renders this component on permission changes
    // (e.g. after silent refresh), so the tab appears/disappears live.
    const canManageMembers = usePermission('workspace:admin', wsId ?? null)
    // Data-source mutations (Add / Edit / Delete / Re-aggregate / Purge)
    // gate on workspace:datasource:manage. Edit + Delete are gated
    // inside the detail panel itself; Add lives here. system:admin is
    // implied by has_permission's shortcut chain so we don't OR it in.
    const canManageDataSources = usePermission(
        'workspace:datasource:manage', wsId ?? null,
    )

    // Sync activeSection back to the URL so refresh / back navigation
    // preserves the tab. Only writes when the value actually differs to
    // avoid history spam.
    useEffect(() => {
        const current = searchParams.get('tab')
        const desired = activeSection === 'sources' ? null : activeSection
        if (current === desired) return
        const next = new URLSearchParams(searchParams)
        if (desired === null) next.delete('tab')
        else next.set('tab', desired)
        setSearchParams(next, { replace: true })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeSection])

    // ``?ds=<id>`` deep-links straight into a data source's detail panel
    // (e.g. the Ontology page's Health tab "Full analysis" link). Applied
    // once the workspace has loaded so the id can be validated; kept in the
    // URL while the panel is open, dropped when it closes.
    useEffect(() => {
        const dsParam = searchParams.get('ds')
        if (!workspace) return
        if (dsParam && selectedDsId !== dsParam
            && workspace.dataSources.some(ds => ds.id === dsParam)) {
            setSelectedDsId(dsParam)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workspace, searchParams])
    useEffect(() => {
        const current = searchParams.get('ds')
        const desired = selectedDsId
        if (current === desired || (!current && !desired)) return
        const next = new URLSearchParams(searchParams)
        if (desired) next.set('ds', desired)
        else next.delete('ds')
        setSearchParams(next, { replace: true })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedDsId])

    // ── Sync editName/editDesc when workspace loads ────────
    useEffect(() => {
        if (workspace) {
            setEditName(workspace.name)
            setEditDesc(workspace.description || '')
        }
    }, [workspace])

    // ── Document title ────────────────────────────────────
    useDocumentTitle(workspace ? `${workspace.name} · Workspaces` : 'Workspace')

    // ── Derived data ───────────────────────────────────────
    const ontologyNameMap = useMemo(() => {
        const map: Record<string, string> = {}
        for (const o of ontologies) map[o.id] = `${o.name} v${o.version}`
        return map
    }, [ontologies])

    const allowedCatalogItems = useMemo(() => {
        if (!wsId || !catalogItems) return []
        const attached = new Set((workspace?.dataSources ?? []).map(ds => ds.catalogItemId))
        return catalogItems
            .filter(item =>
                item.permittedWorkspaces.includes('*') || item.permittedWorkspaces.includes(wsId)
            )
            // Already attached HERE. The old dropdown offered these again, so the
            // same source could be added to the workspace twice.
            .map(item => attached.has(item.id)
                ? { ...item, boundWorkspaceId: wsId, boundWorkspaceName: workspace?.name ?? 'this workspace' }
                : item)
    }, [wsId, catalogItems, workspace])

    const selectedDs = useMemo(() => {
        if (!workspace || !selectedDsId) return null
        return workspace.dataSources.find(ds => ds.id === selectedDsId) || null
    }, [workspace, selectedDsId])

    const primaryOntologyName = useMemo(() => {
        if (!workspace) return undefined
        const primaryDs = workspace.dataSources.find(ds => ds.isPrimary)
        if (primaryDs?.ontologyId) return ontologyNameMap[primaryDs.ontologyId]
        return undefined
    }, [workspace, ontologyNameMap])

    // ── Handlers ───────────────────────────────────────────
    const handleSaveHeader = async () => {
        if (!wsId || !editName.trim()) return
        await workspaceService.update(wsId, { name: editName, description: editDesc || undefined })
        setEditingHeader(false)
        reload()
    }

    const handleSetPrimary = async (dsId: string) => {
        if (!wsId) return
        await workspaceService.setPrimaryDataSource(wsId, dsId)
        reload()
    }

    // Any delete or restore must refresh BOTH the live grid and the trash below it.
    const [trashKey, setTrashKey] = useState(0)
    const deletion = useDataSourceDeletion(wsId, () => { reload(); setTrashKey(k => k + 1) })

    /**
     * Persist the Aggregation tab as a single transaction. Only fields that
     * actually changed are written, so we avoid spurious updateDataSource calls
     * when the user only toggled the projection mode.
     */
    const handleSaveAggregationConfig = async (
        dsId: string,
        pending: { projectionMode: string; dedicatedGraphName: string; identityProperty: string },
        original: { projectionMode: string; dedicatedGraphName: string; identityProperty: string },
    ) => {
        if (!wsId) return
        const modeChanged = pending.projectionMode !== original.projectionMode
        const nameChanged = pending.dedicatedGraphName !== original.dedicatedGraphName
        const identityChanged = pending.identityProperty !== original.identityProperty
        if (modeChanged) {
            await workspaceService.setProjectionMode(wsId, dsId, pending.projectionMode)
        }
        if (nameChanged || identityChanged) {
            await workspaceService.updateDataSource(wsId, dsId, {
                ...(nameChanged ? { dedicatedGraphName: pending.dedicatedGraphName || undefined } : {}),
                // Empty string clears back to the default "urn" server-side.
                ...(identityChanged ? { identityProperty: pending.identityProperty } : {}),
            })
        }
        if (modeChanged || nameChanged || identityChanged) {
            showToast('success', 'Aggregation settings saved')
            reload()
        }
    }

    const handleEditDsSave = async (label: string, ontologyId: string | undefined) => {
        if (!wsId || !selectedDs) return
        await workspaceService.updateDataSource(wsId, selectedDs.id, { label, ontologyId })
        reload()
    }

    const handleReaggregate = async (ds: DataSourceResponse) => {
        if (!wsId) return
        try {
            // Use the canonical service path (``aggregationService``)
            // so the structured backend error envelope —
            // ``{detail: {error, permission, scope, message}}`` — gets
            // unpacked correctly by ``authFetch``. The previous
            // hand-rolled raw-fetch path coerced the structured
            // ``detail`` object into ``"[object Object]"`` via
            // ``new Error(object)`` and the user saw that in their
            // toast.
            await aggregationService.triggerAggregation(ds.id, {
                projectionMode: ds.projectionMode || 'in_source',
                batchSize: 1000,
            }, 'manual')
            showToast('success', `Aggregation triggered for "${ds.label || 'data source'}"`)
            reload()
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Failed to trigger aggregation'
            showToast('error', msg)
        }
    }

    const handlePurge = async (ds: DataSourceResponse) => {
        try {
            const result = await aggregationService.purgeAggregation(ds.id)
            showToast('success', `Purged ${result.deletedEdges.toLocaleString()} aggregated edges`)
            reload()
        } catch (err: any) {
            showToast('error', err?.message ?? 'Purge failed')
            throw err
        }
    }


    // ── Render ─────────────────────────────────────────────
    if (isLoading) {
        // Skeleton card grid (matches the data-source grid below) instead of a
        // lone centered spinner — reads as "content loading" and cuts the
        // perceived wait. isLoading is keep-previous across the same wsId, so
        // this only shows on the first load of a new workspace.
        return (
            <div className="w-full h-full overflow-y-auto custom-scrollbar">
                <PageContainer className="py-8">
                    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
                        {Array.from({ length: 6 }).map((_, i) => (
                            <WorkspaceCardSkeleton key={i} />
                        ))}
                    </div>
                </PageContainer>
            </div>
        )
    }

    if (!workspace) {
        // Detect "had access but lost it" vs. "never existed".
        // ``hadAccessRef`` is set once when the workspace first loads
        // successfully. If it's now gone AND the current claims no
        // longer include this ``wsId``, the most likely cause is that
        // an admin revoked the user's binding while they were on the
        // page. Render a friendlier "Access revoked" view instead of a
        // generic 404, and offer to request access back.
        const claimsHaveWs = !!wsId && !!claims.ws?.[wsId]
        const accessRevoked = hadAccessRef.current && !claimsHaveWs
        if (accessRevoked && wsId) {
            return (
                <AccessRevokedPanel
                    wsId={wsId}
                    onNavigateHome={() => navigate('/workspaces')}
                />
            )
        }
        return (
            <div className="flex flex-col items-center justify-center h-full">
                <p className="text-ink-muted">Workspace not found.</p>
                <button onClick={() => navigate('/workspaces')} className="mt-4 text-indigo-500 hover:underline text-sm">&larr; Back to Workspaces</button>
            </div>
        )
    }

    return (
        <div className="absolute inset-0 overflow-y-auto bg-canvas">
        <PageContainer className="py-8 animate-in fade-in duration-500">
            {/* Breadcrumb */}
            <div className="flex items-center justify-between mb-6">
                <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm">
                    <Link to="/workspaces" className="flex items-center gap-1.5 text-ink-muted hover:text-ink transition-colors">
                        <ChevronLeft className="w-4 h-4" /> Workspaces
                    </Link>
                    <span className="text-ink-muted/60">/</span>
                    <span className="font-medium text-ink truncate max-w-[32ch]" title={workspace.name}>{workspace.name}</span>
                </nav>
                {/* Subtle refresh indicator — in-place, never unmounts the page */}
                {isRefreshing && (
                    <span
                        className="flex items-center gap-1.5 text-[11px] text-ink-muted"
                        aria-live="polite"
                        role="status"
                    >
                        <RefreshCw className="w-3 h-3 animate-spin" /> Refreshing
                    </span>
                )}
            </div>

            {/* Hero Header */}
            <WorkspaceHeroHeader
                workspace={workspace}
                healthStatus={healthStatus}
                aggregateStats={aggregateStats}
                primaryOntologyName={primaryOntologyName}
                providerInfos={Object.values(dsProviderMap)}
                isEditing={editingHeader}
                editName={editName}
                editDesc={editDesc}
                onEditNameChange={setEditName}
                onEditDescChange={setEditDesc}
                onStartEdit={() => setEditingHeader(true)}
                onSave={handleSaveHeader}
                onCancel={() => { setEditingHeader(false); setEditName(workspace.name); setEditDesc(workspace.description || '') }}
            />

            {/* Quick-links bar */}
            <div className="flex items-center gap-2 mt-6 mb-2">
                <span className="text-[10px] font-bold text-ink-muted uppercase tracking-wider mr-1">Quick Links</span>
                <Link to={`/explorer?workspace=${wsId}`}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-ink-muted border border-glass-border hover:text-indigo-500 hover:border-indigo-500/20 hover:bg-indigo-500/5 transition-colors">
                    <Compass className="w-3 h-3" /> Explorer
                </Link>
                <Link to={`/schema?workspaceId=${wsId}`}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-ink-muted border border-glass-border hover:text-violet-500 hover:border-violet-500/20 hover:bg-violet-500/5 transition-colors">
                    <GitBranch className="w-3 h-3" /> Schema Editor
                </Link>
                <Link to="/ingestion?tab=jobs"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-ink-muted border border-glass-border hover:text-emerald-500 hover:border-emerald-500/20 hover:bg-emerald-500/5 transition-colors">
                    <Settings2 className="w-3 h-3" /> Global Jobs
                </Link>
            </div>

            {/* Section Tabs */}
            <div className="flex items-center gap-1 border-b border-glass-border mt-4 mb-0">
                {([
                    { id: 'sources' as const, label: 'Data Sources', icon: Database, count: workspace.dataSources.length, hint: 'Graph databases connected to this workspace' },
                    { id: 'views' as const, label: 'Views', icon: Eye, count: allWorkspaceViews.length, hint: 'Saved visual perspectives on your data' },
                    { id: 'aggregation' as const, label: 'Aggregation', icon: Settings2, hint: 'Edge materialization and job monitoring' },
                    { id: 'ontology' as const, label: 'Ontology', icon: GitBranch, hint: 'Semantic type system and change history' },
                    ...(versioningEnabled
                        ? [{ id: 'reviews' as const, label: 'Reviews', icon: GitPullRequestArrow, hint: 'Merge requests awaiting review across this workspace' }]
                        : []),
                    ...(canManageMembers
                        ? [{ id: 'members' as const, label: 'Members', icon: Users, hint: 'Workspace role bindings — admins / users / viewers' }]
                        : []),
                ]).map(tab => {
                    const Icon = tab.icon
                    const isActive = activeSection === tab.id
                    return (
                        <button key={tab.id} onClick={() => setActiveSection(tab.id)}
                            title={tab.hint}
                            className={cn(
                                'flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-colors duration-150 border-b-2',
                                isActive ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                                         : 'border-transparent text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 rounded-t-xl'
                            )}>
                            <Icon className="w-4 h-4" />
                            {tab.label}
                            {tab.count !== undefined && (
                                <span className={cn("px-1.5 py-0.5 rounded-full text-[10px] font-bold",
                                    isActive ? "bg-indigo-500/20 text-indigo-600 dark:text-indigo-400" : "bg-black/5 dark:bg-white/5 text-ink-muted"
                                )}>{tab.count}</span>
                            )}
                        </button>
                    )
                })}
            </div>

            {/* ── Data Sources Tab ─────────────────────────── */}
            {activeSection === 'sources' && (
                <>
                    {/* Section intro */}
                    <div className="flex items-start gap-3 py-4 mb-2">
                        <Info className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm text-ink-secondary leading-relaxed">
                                Data sources are the graph databases that feed this workspace. Each source can have its own ontology and aggregation configuration.
                                <span className="text-ink-muted"> Click on any card below to inspect its details, configure aggregation, or browse associated views.</span>
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-lg font-bold text-ink">Data Sources</h3>
                        {canManageDataSources && (
                            <button onClick={() => setShowAddDs(true)}
                                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500/10 text-indigo-500 text-sm font-semibold hover:bg-indigo-500/20 transition-colors">
                                <Plus className="w-4 h-4" /> Add Source
                            </button>
                        )}
                    </div>

                    {workspace.dataSources.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-16 border-2 border-dashed border-glass-border rounded-2xl">
                            <Database className="w-10 h-10 text-ink-muted mb-3" />
                            <h4 className="text-sm font-bold text-ink mb-2">No data sources connected</h4>
                            <p className="text-xs text-ink-muted mb-1 max-w-md text-center">
                                Data sources connect this workspace to your enterprise graph databases. Once connected, you can configure ontologies, run aggregation, and create views.
                            </p>
                            <div className="flex items-center gap-4 mt-4 text-[10px] text-ink-muted">
                                <span className="flex items-center gap-1.5"><span className="w-5 h-5 rounded-full bg-indigo-500/10 text-indigo-500 flex items-center justify-center text-[9px] font-bold">1</span> Add a source</span>
                                <span className="flex items-center gap-1.5"><span className="w-5 h-5 rounded-full bg-indigo-500/10 text-indigo-500 flex items-center justify-center text-[9px] font-bold">2</span> Assign ontology</span>
                                <span className="flex items-center gap-1.5"><span className="w-5 h-5 rounded-full bg-indigo-500/10 text-indigo-500 flex items-center justify-center text-[9px] font-bold">3</span> Run aggregation</span>
                                <span className="flex items-center gap-1.5"><span className="w-5 h-5 rounded-full bg-indigo-500/10 text-indigo-500 flex items-center justify-center text-[9px] font-bold">4</span> Create views</span>
                            </div>
                            {canManageDataSources && (
                                <button onClick={() => setShowAddDs(true)}
                                    className="flex items-center gap-2 px-4 py-2 mt-5 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-semibold">
                                    <Plus className="w-4 h-4" /> Add First Source
                                </button>
                            )}
                        </div>
                    ) : (
                        <>
                            {/* Hint for first-time users */}
                            {!selectedDsId && workspace.dataSources.length > 0 && (
                                <div className="flex items-center gap-2 px-3 py-2 mb-3 rounded-lg bg-indigo-500/5 border border-indigo-500/10 text-xs text-indigo-600 dark:text-indigo-400">
                                    <HelpCircle className="w-3.5 h-3.5 shrink-0" />
                                    <span>Click on a data source card to open its detail panel with insights, aggregation settings, and views.</span>
                                </div>
                            )}

                            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
                                {workspace.dataSources.map(ds => {
                                    const onto = ds.ontologyId ? ontologyMap[ds.ontologyId] : undefined
                                    return (
                                        <DataSourceGridCard
                                            key={ds.id}
                                            ds={ds}
                                            stats={dsStatsMap[ds.id]}
                                            providerInfo={dsProviderMap[ds.id]}
                                            ontologyName={onto?.name}
                                            ontologyVersion={onto?.version}
                                            ontologyPublished={onto?.isPublished}
                                            viewCount={(viewsByDs[ds.id] || []).length}
                                            isSelected={selectedDsId === ds.id}
                                            onSelect={() => setSelectedDsId(prev => prev === ds.id ? null : ds.id)}
                                            onSetPrimary={() => handleSetPrimary(ds.id)}
                                        />
                                    )
                                })}
                            </div>
                        </>
                    )}

                    {/* The trash. Renders nothing when it's empty — it appears only when there
                        is actually something to undo, and vanishes again once there isn't. */}
                    {wsId && (
                        <DeletedDataSources
                            wsId={wsId}
                            canManage={canManageDataSources}
                            refreshKey={trashKey}
                            onRestore={deletion.restore}
                            onDeletePermanently={deletion.openPermanent}
                        />
                    )}
                </>
            )}

            {/* ── Views Tab ────────────────────────────────── */}
            {activeSection === 'views' && (
                <>
                    <div className="flex items-start gap-3 py-4 mb-2">
                        <Info className="w-4 h-4 text-cyan-500 shrink-0 mt-0.5" />
                        <p className="text-sm text-ink-secondary leading-relaxed">
                            Views are saved visual perspectives on your graph data — like dashboards for your knowledge graph. Each view can display data as a hierarchy, lineage map, context view, or table.
                            <span className="text-ink-muted"> Filter by data source or search to find specific views. Click any view to open it.</span>
                        </p>
                    </div>
                    <WorkspaceViewsSection wsId={wsId!} dataSources={workspace.dataSources} allViews={allWorkspaceViews} />
                </>
            )}

            {/* ── Aggregation Tab ──────────────────────────── */}
            {activeSection === 'aggregation' && (
                <>
                    <div className="flex items-start gap-3 py-4 mb-2">
                        <Info className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                        <p className="text-sm text-ink-secondary leading-relaxed">
                            Aggregation materializes lineage edges by traversing your graph and computing transitive relationships.
                            This pre-computation enables fast lineage queries in views.
                            <span className="text-ink-muted"> Monitor job progress, configure projection modes, and manage aggregation schedules for each data source below.</span>
                        </p>
                    </div>
                    <WorkspaceAggregationDashboard
                        dataSources={workspace.dataSources}
                        readinessMap={readinessMap}
                        onReaggregate={handleReaggregate}
                        onPurge={handlePurge}
                    />
                </>
            )}

            {/* ── Ontology Tab ─────────────────────────────── */}
            {activeSection === 'ontology' && (
                <>
                    <div className="flex items-start gap-3 py-4 mb-2">
                        <Info className="w-4 h-4 text-violet-500 shrink-0 mt-0.5" />
                        <p className="text-sm text-ink-secondary leading-relaxed">
                            Ontologies define the semantic type system — which entity types and relationship types exist in your data.
                            Each data source can use its own ontology version.
                            <span className="text-ink-muted"> The timeline below shows all changes across ontologies assigned to this workspace's data sources.</span>
                        </p>
                    </div>
                    <WorkspaceOntologyTimeline dataSources={workspace.dataSources} ontologyMap={ontologyMap} />
                </>
            )}

            {/* ── Reviews Tab (merge requests) ────────────── */}
            {versioningEnabled && activeSection === 'reviews' && wsId && (
                <>
                    <div className="flex items-start gap-3 py-4 mb-2">
                        <Info className="w-4 h-4 text-accent-lineage shrink-0 mt-0.5" />
                        <p className="text-sm text-ink-secondary leading-relaxed">
                            Merge requests propose changes to a data source's published graph. Review the itemised
                            changes, resolve any conflicts, and approve or merge.
                            <span className="text-ink-muted"> Spans every versioned data source in this workspace.</span>
                        </p>
                    </div>
                    <WorkspaceReviewsInbox wsId={wsId} />
                </>
            )}

            {/* ── Members Tab (RBAC) ──────────────────────── */}
            {activeSection === 'members' && canManageMembers && wsId && (
                <WorkspaceMembers workspaceId={wsId} />
            )}

            {/* ── Modals ──────────────────────────────────── */}
            <AddDataSourceWizard
                isOpen={showAddDs}
                workspaceId={wsId ?? ''}
                workspaceName={workspace?.name}
                onClose={() => setShowAddDs(false)}
                onAdded={reload}
                catalogItems={allowedCatalogItems}
                providers={providers}
                ontologies={ontologies}
            />

            {/* One dialog, two registers. Removing is disruptive but REVERSIBLE, so it shows the
                full blast radius and then asks for nothing but a click — and the toast carries an
                Undo. Deleting permanently is not reversible, so it keeps the type-to-confirm and
                the copy stops hedging. Friction proportional to consequence. */}
            <DangerConfirmDialog
                isOpen={!!deletion.target}
                title={deletion.target?.permanent ? 'Delete permanently' : 'Offboard data source'}
                subtitle={deletion.target?.label}
                confirmPhrase={deletion.target?.permanent ? (deletion.target?.label ?? '') : ''}
                confirmLabel={deletion.target?.permanent ? 'Delete permanently' : 'Offboard'}
                sections={impactSections(deletion.target?.impact ?? null,
                                         deletion.target?.permanent)}
                loadingImpact={deletion.target?.loading}
                impactUnknown={deletion.target?.unknown}
                safeMessage="Nothing depends on this data source, and it has no version history."
                caveat={deleteCaveat(deletion.target?.impact ?? null, deletion.target?.permanent)}
                onClose={deletion.close}
                onConfirm={deletion.confirm}
            />

            {/* Data source detail drawer (renders via portal — no scroll impact).
                Editing is inline in the drawer now (no separate modal). */}
            <DataSourceDetailPanel
                ds={selectedDs}
                isOpen={!!selectedDsId && !!selectedDs}
                wsId={wsId!}
                stats={selectedDsId ? dsStatsMap[selectedDsId] : undefined}
                providerInfo={selectedDsId ? dsProviderMap[selectedDsId] : undefined}
                ontologyName={selectedDsId ? ontologyNameMap[selectedDs?.ontologyId || ''] : undefined}
                ontologyId={selectedDs?.ontologyId}
                views={selectedDsId ? (viewsByDs[selectedDsId] || []) : []}
                readiness={selectedDsId ? readinessMap[selectedDsId] : undefined}
                ontologies={ontologies}
                onSaveEdit={handleEditDsSave}
                onDelete={workspace.dataSources.length > 1 && selectedDs
                    ? () => deletion.open(selectedDs.id, selectedDs.label || selectedDs.id)
                    : undefined}
                onDeletePermanent={workspace.dataSources.length > 1 && selectedDs
                    ? () => deletion.openPermanent(selectedDs.id, selectedDs.label || selectedDs.id)
                    : undefined}
                onReaggregate={() => { if (selectedDs) handleReaggregate(selectedDs) }}
                onPurge={async () => { if (selectedDs) await handlePurge(selectedDs) }}
                onSetPrimary={() => { if (selectedDsId) handleSetPrimary(selectedDsId) }}
                onSaveAggregationConfig={(pending, original) => {
                    if (selectedDsId) return handleSaveAggregationConfig(selectedDsId, pending, original)
                    return Promise.resolve()
                }}
                onClose={() => setSelectedDsId(null)}
            />
        </PageContainer>
        </div>
    )
}


// ─────────────────────────────────────────────────────────────────────
// Access-revoked panel — rendered when the user had access to this
// workspace earlier in the session but doesn't any more (admin
// revoked their binding while they were on the page). Offers a
// "Request access" CTA that submits via accessRequestsService, and
// auto-redirects home after a short countdown so they aren't stuck
// on a 404-looking screen.
// ─────────────────────────────────────────────────────────────────────

const REDIRECT_AFTER_SECONDS = 8

function AccessRevokedPanel({
    wsId,
    onNavigateHome,
}: {
    wsId: string
    onNavigateHome: () => void
}) {
    const { showToast } = useToast()
    const [secondsLeft, setSecondsLeft] = useState(REDIRECT_AFTER_SECONDS)
    const [requested, setRequested] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    // Pause the countdown if the user is interacting (clicked the
    // request button). Cancelled redirects let the user read the
    // confirmation toast without being yanked away mid-action.
    const [paused, setPaused] = useState(false)

    useEffect(() => {
        if (paused) return
        if (secondsLeft <= 0) {
            onNavigateHome()
            return
        }
        const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000)
        return () => clearTimeout(t)
    }, [secondsLeft, paused, onNavigateHome])

    const handleRequest = async () => {
        setPaused(true)
        setSubmitting(true)
        try {
            await accessRequestsService.submit({
                targetType: 'workspace',
                targetId: wsId,
                requestedRole: 'workspace_member',
                justification: 'Requesting access again after losing membership.',
            })
            setRequested(true)
            showToast('success', 'Access request sent to the workspace admin.')
        } catch (err) {
            showToast('error', err instanceof Error ? err.message : 'Failed to send request')
            setPaused(false)
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <div className="flex items-center justify-center h-full p-6">
            <div className="max-w-md w-full rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6 text-center">
                <div className="w-12 h-12 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center mx-auto mb-4">
                    <ShieldOff className="w-6 h-6 text-amber-500" />
                </div>
                <h2 className="text-lg font-bold text-ink">Access revoked</h2>
                <p className="text-sm text-ink-muted mt-2">
                    Your access to this workspace was removed. You're being
                    redirected to your workspaces list
                    {!paused && (
                        <> in <span className="font-semibold text-ink">{secondsLeft}s</span></>
                    )}
                    .
                </p>
                <div className="mt-5 flex flex-col gap-2">
                    {!requested ? (
                        <button
                            onClick={handleRequest}
                            disabled={submitting}
                            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
                        >
                            {submitting ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <Send className="w-4 h-4" />
                            )}
                            Request access again
                        </button>
                    ) : (
                        <p className="text-xs text-emerald-600 dark:text-emerald-400">
                            Request sent. The workspace admin will review it.
                        </p>
                    )}
                    <button
                        onClick={onNavigateHome}
                        className="w-full px-4 py-2 rounded-xl text-sm font-semibold text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    >
                        Go to workspaces
                    </button>
                </div>
            </div>
        </div>
    )
}
