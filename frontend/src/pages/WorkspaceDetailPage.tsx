/**
 * WorkspaceDetailPage — one workspace, at /workspaces/:wsId.
 *
 * It opens on the Overview — what waits on the reader, the way back into their
 * work, the workspace at a glance — because most people come to a workspace to
 * use it. Its views come next; the data behind them sits under one Data tab
 * (Sources, Data model, Processing, Trends); and the people who run it find
 * People, Activity and Settings after that. Each reader sees only the tabs they
 * can use. Every older link (`?tab=aggregation`, `?ds=…`) still lands in place
 * (see `workspaceTabs`).
 */
import { lazy, Suspense, useState, useEffect, useMemo, useRef, useCallback, useContext } from 'react'
import { Navigate, useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import {
    ChevronLeft, Plus, Database, Settings2, GitBranch, Eye, RefreshCw, Sparkles, Shapes, Activity,
    Users, ShieldOff, Send, GitPullRequestArrow, LineChart, History, Trash2, Layers,
} from 'lucide-react'
import { ViewEditorContext } from '@/components/layout/viewEditorContext'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { Segmented } from '@/components/ui/Segmented'
import { EmptyState } from '@/components/ui/EmptyState'
import { WorkspaceOverview } from '@/components/admin/workspace/overview/WorkspaceOverview'
import { WorkspaceSettingsTab } from '@/components/admin/workspace/WorkspaceSettingsTab'
import {
    normalizeWorkspaceTab, workspaceTabParams, type DataSection, type WorkspaceTab,
} from '@/components/admin/workspace/workspaceTabs'
import { describeWorkspaceHealth } from '@/components/admin/workspace/workspaceHealthStory'
import type { HeroLink } from '@/components/admin/workspace/WorkspaceHeroHeader'
import { Link } from 'react-router-dom'
import { WorkspaceReviewsInbox } from '@/features/reviews/components/WorkspaceReviewsInbox'
import { workspaceService, type DataSourceResponse } from '@/services/workspaceService'
import { DangerConfirmDialog } from '@/components/ui/DangerConfirmDialog'
import {
    useDataSourceDeletion, impactSections, deleteCaveat,
} from '@/components/admin/workspace/useDataSourceDeletion'
import { DeletedDataSources } from '@/components/admin/workspace/DeletedDataSources'
import { aggregationService } from '@/services/aggregationService'
import { DEFAULT_TIMEOUT_SECS } from '@/components/admin/shared/AggregationOverridesForm'
import { useAppNotifications } from '@/components/ui/notifications'
import { usePermission, usePermissionClaims } from '@/store/auth'
import { useFeature } from '@/store/features'
import { RequestAccessDialog } from '@/components/access/RequestAccessDialog'
import { AddDataSourceWizard } from '@/components/admin/workspace/AddDataSourceWizard'
import { useWorkspaceDetailData } from '@/components/admin/workspace/useWorkspaceDetailData'
import { WorkspaceHeroHeader } from '@/components/admin/workspace/WorkspaceHeroHeader'
import { DataSourceGridCard } from '@/components/admin/workspace/DataSourceGridCard'
import { useSubjectCounts } from '@/features/discussions/useDiscussions'
import { DataSourceFilterBar } from '@/components/admin/workspace/DataSourceFilterBar'
import { NO_FILTER, filterDataSources, wantsFilterBar, type DataSourceFilter } from '@/lib/dataSourceFilter'
import { rankTags } from '@/lib/tags'
import { DATA_SOURCE_METADATA_FEATURE } from '@/services/dataSourceMetadataService'
import { WorkspaceCardSkeleton } from '@/components/admin/workspace/WorkspaceCardSkeleton'
import { DataSourceDetailPanel } from '@/components/admin/workspace/DataSourceDetailPanel'
import { SettingsSkeleton } from '@/components/admin/AdminVersionedGraphs/states'
import WorkspaceViewsSection from '@/components/admin/workspace/WorkspaceViewsSection'
import { WorkspaceAggregationDashboard } from '@/components/admin/workspace/WorkspaceAggregationDashboard'
import { WorkspaceOntologyTimeline } from '@/components/admin/workspace/WorkspaceOntologyTimeline'
import { WorkspaceMembers } from '@/components/workspaces/WorkspaceMembers'
import { PageContainer } from '@/components/layout/PageContainer'
import { ProfilingBoard } from '@/components/ingestion/profiling/ProfilingBoard'
import { useCanReadProfiling } from '@/hooks/useProfilingAccess'
import { usePlayground } from '@/hooks/usePlayground'
import { useMyWorkspaceRequests } from '@/hooks/useWorkspaceRequests'
import { WorkspaceWelcomeBanner } from '@/components/workspace-requests/WorkspaceWelcomeBanner'
import { AskForDataButton } from '@/components/data-requests/AskForData'
import { WorkspaceDataRequestsPanel } from '@/components/data-requests/WorkspaceDataRequestsPanel'
import { DATA_REQUESTS_FEATURE, useAskForData } from '@/hooks/useDataRequests'
import { ActivityExplorer } from '@/components/activity/ActivityExplorer'
import { workspaceActivityScope } from '@/components/activity/activityMeta'
import { useReasonPrompt } from '@/components/activity/useReasonPrompt'
import { MoveDataSourceWizard, type MoveDataSourceWizardProps } from '@/features/data-source-transfer/MoveDataSourceWizard'
import { TransferRequestsPanel } from '@/features/data-source-transfer/TransferRequestsPanel'
import { useDataSourcesWithForks, useReviewInboxCounts } from '@/features/versioning/hooks/useVersioning'
import { isForkDataSourceId } from '@/features/versioning/model/forks'

// The Versioned graphs tab carries the settings kit: it loads when first opened.
const WorkspaceVersionedGraphs = lazy(() => import('@/components/admin/AdminVersionedGraphs/WorkspaceVersionedGraphs')
    .then((m) => ({ default: m.WorkspaceVersionedGraphs })))

// ─────────────────────────────────────────────────────────────────────
// WorkspaceDetailPage
// ─────────────────────────────────────────────────────────────────────

export function WorkspaceDetailPage() {
    const { wsId } = useParams<{ wsId: string }>()
    const navigate = useNavigate()
    const { notify } = useAppNotifications()

    // ── Data fetching via custom hook ──────────────────────
    const {
        workspace, catalogItems, providers, ontologies, ontologyMap, dsStatsMap, dsProviderMap,
        allWorkspaceViews, viewTotal, viewCountByDs, readinessMap, healthStatus,
        aggregateStats, pending, isLoading, isRefreshing, reload
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

    // ── Move wizard: a source of ours going elsewhere, or one pulled in here ──
    const [moving, setMoving] = useState<Pick<MoveDataSourceWizardProps,
        'sourceWorkspace' | 'dataSource' | 'presetDestinationId'> | null>(null)

    // ── Delete confirm state ───────────────────────────────

    // ── Edit DS modal state ────────────────────────────────

    // ── Selection + tab state ──────────────────────────────
    const [selectedDsId, setSelectedDsId] = useState<string | null>(null)
    const [searchParams, setSearchParams] = useSearchParams()
    const canReadProfiling = useCanReadProfiling()
    // Where the reader is, read from the address — so Back, a shared link and the
    // server's notifications (`?tab=members`, `?tab=views`, an old `?tab=aggregation`)
    // all land in place. A link that opens a data source opens on Data.
    const requested = normalizeWorkspaceTab(searchParams.get('tab'), searchParams.get('section'), {
        hasDataSource: !!searchParams.get('ds'),
    })
    const goTo = useCallback((tab: WorkspaceTab, section: DataSection = 'sources') => {
        const p = workspaceTabParams({ tab, section })
        setSearchParams(prev => {
            const next = new URLSearchParams(prev)
            if (p.tab) next.set('tab', p.tab); else next.delete('tab')
            if (p.section) next.set('section', p.section); else next.delete('section')
            return next
        }, { replace: true })
    }, [setSearchParams])
    // Reviews and Versioned graphs are versioning surfaces; the tabs (and their deep links)
    // disappear when the admin turns version control off.
    const versioningEnabled = useFeature('versioningEnabled')
    // Changes staged on the Versioned graphs tab: it stays mounted (hidden) while any are, so
    // looking at another tab never drops them, and its tab says how many.
    const [vgStaged, setVgStaged] = useState(0)

    // Letting people in opens the Members tab — admins and stewards; the
    // admins also remove people and set how people get in. The store's
    // `usePermission` re-renders this component on permission changes
    // (e.g. after silent refresh), so the tab appears/disappears live.
    const canManageMembers = usePermission('workspace:admin', wsId ?? null)
    const canAddMembers = usePermission('workspace:members:add', wsId ?? null)
    // The Activity tab: a workspace admin reads this workspace's activity; an
    // auditor reads everything recorded against it, through the platform log.
    const isAuditor = usePermission('system:audit:read')
    const activityScope = workspaceActivityScope(wsId, { isAdmin: canManageMembers, isAuditor })
    // Rebuilds and purges from this page confirm here, and ask why.
    const [reasonPrompt, askReason] = useReasonPrompt()
    // Data-source mutations (Add / Edit / Delete / Re-aggregate / Purge)
    // gate on workspace:datasource:manage. Edit + Delete are gated
    // inside the detail panel itself; Add lives here. system:admin is
    // implied by has_permission's shortcut chain so we don't OR it in.
    const canManageDataSources = usePermission(
        'workspace:datasource:manage', wsId ?? null,
    )
    // Data the reader can't add themselves: asked for here (undefined where it can't be).
    const askForData = useAskForData(workspace)

    // Creating a view here starts on this workspace. The editor lives in the app
    // shell; outside it (a test, a harness) there is simply no New view.
    const viewEditor = useContext(ViewEditorContext)
    // The Playground is open to all: someone not in it yet who follows a link to it is let in.
    const playground = usePlayground().data
    // The reader's own workspace requests: the one this workspace came from says what was done for them.
    const myRequests = useMyWorkspaceRequests().data
    const canCreateView = usePermission('workspace:view:create', wsId ?? null)
    const canEditSchema = usePermission('workspace:ontology:manage', wsId ?? null)
    const openNewView = viewEditor && canCreateView && wsId
        ? () => viewEditor.openViewEditor(undefined, { workspaceId: wsId })
        : undefined
    // The Playground's "Start a blank graph": the wizard on a blank graph, on its sandbox provider.
    const openNewGraph = viewEditor && canCreateView && wsId
        ? (providerId?: string) => viewEditor.openViewEditor(undefined, { workspaceId: wsId, journey: 'blank', providerId })
        : undefined
    // What waits on the reader in Reviews, for the tab's badge.
    const reviewCounts = useReviewInboxCounts(wsId, versioningEnabled).data?.counts
    const reviewsWaiting = reviewCounts ? reviewCounts.needs_review + reviewCounts.sent_back : 0

    // A fork's data source is not among the workspace's: its lists leave forks out. While the link
    // or the panel names one, read the list that includes them.
    const forkSources = useDataSourcesWithForks(
        wsId, isForkDataSourceId(searchParams.get('ds')) || isForkDataSourceId(selectedDsId)).data

    // ``?ds=<id>`` deep-links straight into a data source's detail panel
    // (e.g. the Ontology page's Health tab "Full analysis" link). Applied
    // once the workspace has loaded so the id can be validated; kept in the
    // URL while the panel is open, dropped when it closes. A fork's opens the
    // same way (its Open, its strip's parent link, Admin's Open source).
    useEffect(() => {
        const dsParam = searchParams.get('ds')
        if (!workspace) return
        if (dsParam && selectedDsId !== dsParam
            && (workspace.dataSources.some(ds => ds.id === dsParam)
                || !!forkSources?.some(ds => ds.id === dsParam && ds.forkOf))) {
            setSelectedDsId(dsParam)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workspace, searchParams, forkSources])
    useEffect(() => {
        const current = searchParams.get('ds')
        const desired = selectedDsId
        // A source opened from a link with no tab belongs to Data: say so in the
        // address, so closing its panel leaves the reader on Data, not the Overview.
        const pinData = !!desired && !searchParams.get('tab')
        if (!pinData && (current === desired || (!current && !desired))) return
        // A link waits for the workspace to load (a notification's lands on an empty cache);
        // the effect above opens its panel then.
        if (!desired && current && !workspace) return
        // A fork's link waits for the list that includes forks, rather than being dropped as unknown.
        if (!desired && isForkDataSourceId(current) && !forkSources) return
        const next = new URLSearchParams(searchParams)
        if (desired) next.set('ds', desired)
        else next.delete('ds')
        if (pinData) next.set('tab', 'data')
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
        return workspace.dataSources.find(ds => ds.id === selectedDsId)
            || forkSources?.find(ds => ds.id === selectedDsId && ds.forkOf) || null
    }, [workspace, selectedDsId, forkSources])
    // A fork's data source goes to the trash, back and away with the fork (and moves with its
    // parent): the data-source routes refuse it, so its panel doesn't offer them.
    const isFork = !!selectedDs?.forkOf

    const primaryOntologyName = useMemo(() => {
        if (!workspace) return undefined
        const primaryDs = workspace.dataSources.find(ds => ds.isPrimary)
        if (primaryDs?.ontologyId) return ontologyNameMap[primaryDs.ontologyId]
        return undefined
    }, [workspace, ontologyNameMap])

    // ── Data source details: the Sources filter, and the tags offered when tagging one ──
    const sourceDetails = useFeature(DATA_SOURCE_METADATA_FEATURE)
    const dataRequestsOn = useFeature(DATA_REQUESTS_FEATURE)
    const [dsFilter, setDsFilter] = useState<DataSourceFilter>(NO_FILTER)
    const showDsFilter = sourceDetails && wantsFilterBar(workspace?.dataSources ?? [])
    const shownSources = useMemo(() => {
        const all = workspace?.dataSources ?? []
        return showDsFilter ? filterDataSources(all, dsFilter, ds => dsProviderMap[ds.id]?.catalogItemName) : all
    }, [workspace, showDsFilter, dsFilter, dsProviderMap])
    const filterByTag = useCallback((tag: string) => setDsFilter(f => ({ ...f, tag })), [])
    // The sources' questions, for their cards: one request for all of them, while the cards show.
    const showingSources = requested.tab === 'data' && requested.section === 'sources'
    const sourceQuestions = useSubjectCounts('data_source',
        useMemo(() => (showingSources ? (workspace?.dataSources ?? []).map(ds => ds.id) : []), [showingSources, workspace]))
    // A card's "?" opens its source on the Questions tab, on the list (as a link to it would).
    const openSourceQuestions = useCallback((dsId: string) => setSearchParams(prev => {
        const next = new URLSearchParams(prev)
        next.set('ds', dsId)
        next.set('dstab', 'questions')
        next.delete('discussion')
        next.delete('message')
        return next
    }, { replace: true }), [setSearchParams])
    const tagSuggestions = useMemo(() => sourceDetails
        ? rankTags([...(workspace?.dataSources ?? []).map(ds => ds.tags), ...allWorkspaceViews.map(v => v.tags)])
        : [], [sourceDetails, workspace, allWorkspaceViews])
    // The data request a source came from is listed under Data → Sources.
    const showDataRequests = useCallback(() => {
        setSelectedDsId(null)
        goTo('data', 'sources')
        window.setTimeout(() => document.getElementById('ws-data-requests-title')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200)
    }, [goTo])

    // ── Handlers ───────────────────────────────────────────
    const handleSaveHeader = async () => {
        if (!wsId || !editName.trim()) return
        const name = editName.trim()
        const renamed = name !== workspace?.name
        try {
            await workspaceService.update(wsId, { name: editName, description: editDesc || undefined })
        } catch (err) {
            // Leave the header in edit mode with what they typed — closing it here
            // would swallow the edit as well as the failure.
            notify('error', err instanceof Error && err.message
                ? err.message
                : `Could not save the changes to “${workspace?.name ?? 'this workspace'}”.`)
            return
        }
        setEditingHeader(false)
        notify('success', renamed
            ? `Workspace renamed to “${name}”.`
            : `Description updated for “${name}”.`)
        reload()
    }

    const handleSetPrimary = async (dsId: string) => {
        if (!wsId) return
        const label = workspace?.dataSources.find(ds => ds.id === dsId)?.label || 'That data source'
        try {
            await workspaceService.setPrimaryDataSource(wsId, dsId)
            notify('success', `“${label}” is now the primary data source for this workspace.`)
        } catch (err) {
            notify('error', err instanceof Error && err.message
                ? err.message
                : `Could not make “${label}” the primary data source.`)
        }
        // Either way — the Primary badge on the grid has to end up matching the server.
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
        pending: { projectionMode: string; dedicatedGraphName: string; identityProperty: string; nameProperty: string },
        original: { projectionMode: string; dedicatedGraphName: string; identityProperty: string; nameProperty: string },
    ) => {
        if (!wsId) return
        const modeChanged = pending.projectionMode !== original.projectionMode
        const nameChanged = pending.dedicatedGraphName !== original.dedicatedGraphName
        const identityChanged = pending.identityProperty !== original.identityProperty
        const namePropChanged = pending.nameProperty !== original.nameProperty
        if (!modeChanged && !nameChanged && !identityChanged && !namePropChanged) return
        const label = workspace?.dataSources.find(ds => ds.id === dsId)?.label || 'this data source'
        try {
            if (modeChanged) {
                await workspaceService.setProjectionMode(wsId, dsId, pending.projectionMode)
            }
            if (nameChanged || identityChanged || namePropChanged) {
                await workspaceService.updateDataSource(wsId, dsId, {
                    ...(nameChanged ? { dedicatedGraphName: pending.dedicatedGraphName || undefined } : {}),
                    // Empty string clears the override server-side, so the source
                    // inherits from its provider / workspace / the platform again.
                    ...(identityChanged ? { identityProperty: pending.identityProperty } : {}),
                    ...(namePropChanged ? { nameProperty: pending.nameProperty } : {}),
                })
            }
            notify('success', `Aggregation settings saved for “${label}”.`)
        } catch (err) {
            // Two writes, not one: the mode can land and the rest fail. Reload either
            // way so the panel resyncs to whatever actually made it to the server.
            notify('error', err instanceof Error && err.message
                ? err.message
                : `Could not save the aggregation settings for “${label}”.`)
        }
        reload()
    }

    const handleEditDsSave = async (label: string, ontologyId: string | undefined) => {
        if (!wsId || !selectedDs) return
        const renamed = label !== (selectedDs.label ?? '')
        try {
            await workspaceService.updateDataSource(wsId, selectedDs.id, { label, ontologyId })
        } catch (err) {
            notify('error', err instanceof Error && err.message
                ? err.message
                : `Could not save the changes to “${selectedDs.label || 'this data source'}”.`)
            // Rethrown so the panel keeps its edit form — and the typed label — open.
            // Same contract as handlePurge below.
            throw err
        }
        notify('success', renamed
            ? `Data source renamed to “${label}”.`
            : `Ontology saved for “${label}”.`)
        reload()
    }

    const handleReaggregate = async (ds: DataSourceResponse) => {
        if (!wsId) return
        const answer = await askReason({
            title: `Re-trigger aggregation for "${ds.label || 'this data source'}"?`,
            message: 'Rebuilds its aggregated lineage with the current settings.',
            confirmLabel: 'Re-trigger',
            confirmIcon: RefreshCw,
            context: 'aggregation',
            audience: 'workspace',
        })
        if (!answer) return
        try {
            // Use the canonical service path (``aggregationService``)
            // so the structured backend error envelope —
            // ``{detail: {error, permission, scope, message}}`` — gets
            // unpacked correctly by ``authFetch``. The previous
            // hand-rolled raw-fetch path coerced the structured
            // ``detail`` object into ``"[object Object]"`` via
            // ``new Error(object)`` and the user saw that in their
            // notification.
            await aggregationService.triggerAggregation(ds.id, {
                projectionMode: ds.projectionMode || 'in_source',
                batchSize: 1000,
                // Omit ``tuning`` on purpose: the control plane then resolves
                // the admin's configured defaults, so this button always runs
                // the current settings rather than a frozen client-side copy.
                // ``timeoutSecs`` is NOT resolved that way — a null column
                // falls back to the 15-minute stall window — so it is sent.
                timeoutSecs: DEFAULT_TIMEOUT_SECS,
            }, 'manual', { reason: answer.reason })
            notify('success', `Aggregation triggered for "${ds.label || 'data source'}"`)
            reload()
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Failed to trigger aggregation'
            notify('error', msg)
        }
    }

    // Bulk strategic rebuild: re-trigger aggregation for every aggregatable
    // data source in the workspace. A re-run heals graphs materialized before
    // the depth-stamp contract (reconcile rewrites depth-null cells and bumps
    // _AggMeta.stampVersion to 2), fixing self-nesting hierarchies that read
    // degenerate on legacy generations. Per-source failures (e.g. 409 when a
    // job is already running, or a gate rejection) are tolerated and summarised
    // — one notification, one reload — rather than aborting the whole sweep.
    const handleReaggregateAll = async () => {
        if (!wsId) return
        const targets = (workspace?.dataSources ?? []).filter(
            ds => ds.isActive !== false && ds.ontologyId,
        )
        if (targets.length === 0) {
            notify('info', 'No aggregatable data sources (each needs an assigned ontology).')
            return
        }
        const answer = await askReason({
            title: `Rebuild all ${targets.length} aggregations?`,
            message: 'Re-runs aggregation for every data source in this workspace that has an ontology. Sources with a run already active are skipped.',
            confirmLabel: 'Rebuild all',
            confirmIcon: RefreshCw,
            context: 'aggregation',
            audience: 'workspace',
        })
        if (!answer) return
        const results = await Promise.allSettled(
            targets.map(ds => aggregationService.triggerAggregation(ds.id, {
                projectionMode: ds.projectionMode || 'in_source',
                batchSize: 1000,
                // Same as handleReaggregate: tuning resolves server-side,
                // the stall timeout does not.
                timeoutSecs: DEFAULT_TIMEOUT_SECS,
            }, 'manual', { reason: answer.reason })),
        )
        const triggered = results.filter(r => r.status === 'fulfilled').length
        const skipped = results.length - triggered
        notify(
            skipped ? 'warning' : 'success',
            `Rebuild triggered for ${triggered}/${targets.length} data source(s)`
            + (skipped ? ` — ${skipped} skipped (already running or gated)` : ''),
        )
        reload()
    }

    const handlePurge = async (ds: DataSourceResponse) => {
        const answer = await askReason({
            title: `Purge aggregated edges for "${ds.label || 'this data source'}"?`,
            message: 'Removes all materialized aggregated edges and resets aggregation status. This cannot be undone.',
            confirmLabel: 'Purge',
            confirmIcon: Trash2,
            context: 'purge',
            audience: 'workspace',
            tone: 'danger',
        })
        if (!answer) return
        try {
            const result = await aggregationService.purgeAggregation(ds.id, { reason: answer.reason })
            notify('success', `Purged ${result.deletedEdges.toLocaleString()} aggregated edges`)
            reload()
        } catch (err: any) {
            notify('error', err?.message ?? 'Purge failed')
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
        if (wsId && playground?.workspaceId === wsId && !playground.joined) {
            return <Navigate to="/playground" replace />
        }
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
        return wsId
            ? <WorkspaceUnavailablePanel wsId={wsId} onNavigateHome={() => navigate('/workspaces')} />
            : (
                <div className="flex flex-col items-center justify-center h-full">
                    <p className="text-ink-muted">Workspace not found.</p>
                    <button onClick={() => navigate('/workspaces')} className="mt-4 text-indigo-500 hover:underline text-sm">&larr; Back to Workspaces</button>
                </div>
            )
    }

    // ── What the page shows this reader ──────────────────────
    const healthStory = describeWorkspaceHealth(
        healthStatus,
        workspace.dataSources.map(ds => ({
            label: ds.label || dsProviderMap[ds.id]?.catalogItemName || 'A data source',
            aggregationStatus: readinessMap[ds.id]?.aggregationStatus ?? ds.aggregationStatus,
            projectorCurrent: readinessMap[ds.id]?.projectorCurrent,
        })),
        { canManage: canManageDataSources },
    )
    const moreLinks: HeroLink[] = [
        ...(canEditSchema ? [{ label: 'Edit the data model', to: `/schema?workspaceId=${wsId}`, icon: GitBranch }] : []),
        ...(canManageDataSources ? [{ label: 'Ingestion jobs', to: '/ingestion?tab=jobs', icon: Settings2 }] : []),
    ]
    // A source's views, exactly: undefined while they are counted, null when they couldn't be.
    const viewsOn = (dsId: string) => viewCountByDs ? (viewCountByDs[dsId] ?? 0) : pending.viewCounts ? undefined : null
    const tabs: Array<{ id: WorkspaceTab; label: string; icon: typeof Eye; count?: number; alert?: number }> = [
        { id: 'overview', label: 'Overview', icon: Sparkles },
        { id: 'views', label: 'Views', icon: Eye, count: viewTotal ?? undefined },
        { id: 'data', label: 'Data', icon: Database, count: workspace.dataSources.length },
        ...(versioningEnabled ? [
            { id: 'reviews' as const, label: 'Reviews', icon: GitPullRequestArrow, alert: reviewsWaiting },
            { id: 'versioned-graphs' as const, label: 'Versioned graphs', icon: Layers },
        ] : []),
        ...(canAddMembers ? [{ id: 'members' as const, label: 'People', icon: Users }] : []),
        ...(activityScope ? [{ id: 'activity' as const, label: 'Activity', icon: History }] : []),
        // The Playground's settings are its administrator's: a member manages only their own graphs.
        ...(canManageMembers || (canManageDataSources && workspace.kind !== 'playground')
            ? [{ id: 'settings' as const, label: 'Settings', icon: Settings2 }] : []),
    ]
    // A tab this reader can't open (an old Members link, say) reads as the Overview.
    const activeTab: WorkspaceTab = tabs.some(t => t.id === requested.tab) ? requested.tab : 'overview'
    const dataSection: DataSection = requested.section === 'trends' && !canReadProfiling ? 'sources' : requested.section
    const dataSections = [
        { value: 'sources' as const, label: 'Sources', icon: Database, count: workspace.dataSources.length },
        { value: 'model' as const, label: 'Data model', icon: Shapes },
        { value: 'processing' as const, label: 'Processing', icon: Activity },
        ...(canReadProfiling ? [{ value: 'trends' as const, label: 'Trends', icon: LineChart }] : []),
    ]

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

            {/* Hero: what this is, whether it's ready, and the way in */}
            <WorkspaceHeroHeader
                workspace={workspace}
                healthStatus={healthStatus}
                healthStory={healthStory}
                onHealthAction={section => goTo('data', section)}
                aggregateStats={aggregateStats}
                statsPending={pending.stats}
                primaryOntologyName={primaryOntologyName}
                providerInfos={Object.values(dsProviderMap)}
                exploreHref={`/explorer?workspace=${encodeURIComponent(wsId ?? '')}`}
                onNewView={openNewView}
                moreLinks={moreLinks}
                canEdit={canManageMembers}
                isEditing={editingHeader}
                editName={editName}
                editDesc={editDesc}
                onEditNameChange={setEditName}
                onEditDescChange={setEditDesc}
                onStartEdit={() => setEditingHeader(true)}
                onSave={handleSaveHeader}
                onCancel={() => { setEditingHeader(false); setEditName(workspace.name); setEditDesc(workspace.description || '') }}
            />

            {/* Landing here from an approved request: what was done, and what to do next. */}
            {searchParams.get('welcome') === '1' && (
                <WorkspaceWelcomeBanner
                    name={workspace.name}
                    request={myRequests?.find(r => r.workspaceId === workspace.id) ?? null}
                    onNewView={openNewView}
                    onInvite={canAddMembers ? () => goTo('members') : undefined}
                    onDismiss={() => setSearchParams(prev => { const next = new URLSearchParams(prev); next.delete('welcome'); return next }, { replace: true })}
                />
            )}

            {/* Tabs — only the ones this reader can use. They stay in reach while a
                long tab scrolls, on an opaque strip of the page's own colour (a blur
                inside a scroller re-rasterises every frame). */}
            <div className="sticky top-0 z-20 mt-4 pt-2 bg-canvas">
            <Tabs value={activeTab} onValueChange={v => goTo(v as WorkspaceTab)}>
                <TabsList look="underline" scrollable aria-label="Workspace sections" className="gap-1 sm:gap-2" data-tour="workspace-tabs">
                    {tabs.map(tab => (
                        <TabsTrigger key={tab.id} value={tab.id} icon={tab.icon} className="px-3 h-11 shrink-0"
                            badge={tab.id === 'versioned-graphs' && vgStaged > 0 ? (
                                <span className="ml-0.5 rounded-full bg-indigo-700 px-1.5 text-[10px] font-semibold leading-4 text-white dark:bg-indigo-500">
                                    {vgStaged}<span className="sr-only"> not saved</span>
                                </span>
                            ) : tab.alert ? (
                                <span className="ml-0.5 rounded-full bg-rose-500 px-1.5 text-[10px] font-bold leading-4 text-white">
                                    {tab.alert}<span className="sr-only"> waiting on you</span>
                                </span>
                            ) : tab.count !== undefined ? (
                                <span className="ml-0.5 rounded-full bg-black/[0.05] dark:bg-white/[0.07] px-1.5 text-[10px] font-bold leading-4 text-ink-muted">{tab.count}</span>
                            ) : undefined}>
                            {tab.label}
                        </TabsTrigger>
                    ))}
                </TabsList>
            </Tabs>
            </div>

            {/* ── Overview ─────────────────────────────────── */}
            {activeTab === 'overview' && (
                <WorkspaceOverview
                    workspace={workspace}
                    views={allWorkspaceViews}
                    viewTotal={viewTotal}
                    viewCountByDs={viewCountByDs}
                    pending={pending}
                    readinessMap={readinessMap}
                    aggregateStats={aggregateStats}
                    canManageSources={canManageDataSources}
                    canManageMembers={canManageMembers}
                    canAddMembers={canAddMembers}
                    versioningEnabled={versioningEnabled}
                    showActivity={!!activityScope}
                    onGoTo={goTo}
                    onNewView={openNewView}
                    onAddSource={canManageDataSources ? () => setShowAddDs(true) : undefined}
                    onNewGraph={openNewGraph}
                    onOpenGraph={setSelectedDsId}
                    onMoveGraph={wsId ? (dsId, label) => setMoving({
                        sourceWorkspace: { id: wsId, name: workspace.name }, dataSource: { id: dsId, label },
                    }) : undefined}
                />
            )}

            {/* ── Views ────────────────────────────────────── */}
            {activeTab === 'views' && (
                <>
                    <TabIntro>
                        Saved ways of looking at this workspace’s data — graphs, hierarchies and context views. Open one to explore it.
                    </TabIntro>
                    <WorkspaceViewsSection
                        wsId={wsId!}
                        dataSources={workspace.dataSources}
                        allViews={allWorkspaceViews}
                        publishPolicy={workspace.publishPolicy}
                        onWorkspaceChanged={reload}
                    />
                </>
            )}

            {/* ── Data: Sources · Data model · Processing · Trends ── */}
            {activeTab === 'data' && (
                <>
                    <div className="flex flex-wrap items-center justify-between gap-3 pt-5 pb-1">
                        <Segmented
                            label="Data"
                            size="md"
                            options={dataSections}
                            value={dataSection}
                            onChange={v => goTo('data', v)}
                        />
                        {dataSection === 'sources' && (
                            <div className="flex items-center gap-2">
                                {/* With nothing connected, the empty state below asks instead. */}
                                {(canManageDataSources || workspace.dataSources.length > 0) && (
                                    <AskForDataButton workspace={workspace} primary={!canManageDataSources} />
                                )}
                                {canManageDataSources && workspace.dataSources.length > 0 && (
                                    <button onClick={() => setShowAddDs(true)}
                                        className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 text-sm font-semibold hover:bg-indigo-500/20 transition-colors">
                                        <Plus className="w-4 h-4" /> Add source
                                    </button>
                                )}
                            </div>
                        )}
                    </div>

                    {dataSection === 'sources' && (
                        <>
                            <TabIntro>
                                Where this workspace’s data comes from. Open a source to see what’s in it and the views built on it.
                            </TabIntro>

                            {/* Sources waiting to move in, or to leave — what an admin must answer. */}
                            {canManageMembers && wsId && <TransferRequestsPanel variant="banner" workspaceId={wsId} />}

                            {workspace.dataSources.length === 0 ? (
                                <div className="rounded-3xl border-2 border-dashed border-glass-border">
                                    <EmptyState
                                        icon={Database}
                                        title="No data connected yet"
                                        description={canManageDataSources
                                            ? 'Connect the graph this workspace is about. Next you’ll choose its data model, build its connections and create the first view — the Overview walks you through it.'
                                            : askForData
                                                ? 'Nobody has connected any data here yet. Ask for the data you need — the platform team connects it.'
                                                : 'The people who look after this workspace haven’t connected any data yet.'}
                                        action={canManageDataSources ? { label: 'Connect data', onClick: () => setShowAddDs(true), icon: Plus }
                                            : askForData ? { label: 'Ask for data', onClick: askForData, icon: Plus } : undefined}
                                    />
                                </div>
                            ) : (<>
                                {showDsFilter && (
                                    <DataSourceFilterBar sources={workspace.dataSources} filter={dsFilter} onChange={setDsFilter} shown={shownSources.length} />
                                )}
                                {shownSources.length === 0 && (
                                    <div className="rounded-3xl border-2 border-dashed border-glass-border">
                                        <EmptyState icon={Database} title="No sources match"
                                            description="Nothing here has those words, that tag, that sensitivity or that status."
                                            action={{ label: 'Clear the filter', onClick: () => setDsFilter(NO_FILTER) }} />
                                    </div>
                                )}
                                <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
                                    {shownSources.map(ds => {
                                        const onto = ds.ontologyId ? ontologyMap[ds.ontologyId] : undefined
                                        return (
                                            <DataSourceGridCard
                                                key={ds.id}
                                                ds={ds}
                                                stats={dsStatsMap[ds.id]}
                                                providerInfo={dsProviderMap[ds.id]}
                                                readiness={readinessMap[ds.id]}
                                                ontologyName={onto?.name}
                                                ontologyVersion={onto?.version}
                                                ontologyPublished={onto?.isPublished}
                                                viewCount={viewsOn(ds.id)}
                                                statsPending={pending.stats}
                                                isSelected={selectedDsId === ds.id}
                                                onSelect={() => setSelectedDsId(prev => prev === ds.id ? null : ds.id)}
                                                onSetPrimary={canManageDataSources ? () => handleSetPrimary(ds.id) : undefined}
                                                onTagClick={showDsFilter ? filterByTag : undefined}
                                                questions={sourceQuestions[ds.id]}
                                                onOpenQuestions={() => openSourceQuestions(ds.id)}
                                            />
                                        )
                                    })}
                                </div>
                            </>)}

                            {/* What has been asked for here, and where each request stands. */}
                            {wsId && <WorkspaceDataRequestsPanel workspaceId={wsId} />}

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

                    {dataSection === 'model' && (
                        <>
                            <TabIntro>
                                The kinds of things your data holds and how they relate — and what changed in that model, when.
                            </TabIntro>
                            <WorkspaceOntologyTimeline dataSources={workspace.dataSources} ontologyMap={ontologyMap} />
                        </>
                    )}

                    {dataSection === 'processing' && (
                        <>
                            <TabIntro>
                                How fresh each source’s connections are. Lineage opens fast once they’re built; views keep working while they refresh.
                            </TabIntro>
                            <WorkspaceAggregationDashboard
                                dataSources={workspace.dataSources}
                                readinessMap={readinessMap}
                                canManage={canManageDataSources}
                                onReaggregate={handleReaggregate}
                                onPurge={handlePurge}
                                onReaggregateAll={handleReaggregateAll}
                            />
                        </>
                    )}

                    {dataSection === 'trends' && (
                        <div className="py-4">
                            <ProfilingBoard
                                workspaceId={wsId}
                                onOpenSource={(row) => {
                                    // Drill into the source the board named, landing on
                                    // its Profiling tab rather than its Overview — the
                                    // reader arrived here asking about movement.
                                    const merged = new URLSearchParams(searchParams)
                                    merged.set('ds', row.data_source_id)
                                    merged.set('dstab', 'profiling')
                                    setSearchParams(merged, { replace: true })
                                }}
                            />
                        </div>
                    )}
                </>
            )}

            {/* ── Reviews (merge requests) ────────────────── */}
            {activeTab === 'reviews' && versioningEnabled && wsId && (
                <>
                    <TabIntro>
                        Proposed changes to this workspace’s data, waiting to be reviewed, approved and merged.
                    </TabIntro>
                    <WorkspaceReviewsInbox wsId={wsId} />
                </>
            )}

            {/* ── Versioned graphs Tab (defaults, graphs, history) ── */}
            {versioningEnabled && wsId && (activeTab === 'versioned-graphs' || vgStaged > 0) && (
                <div hidden={activeTab !== 'versioned-graphs'}>
                    <Suspense fallback={<div className="py-4"><SettingsSkeleton /></div>}>
                        <WorkspaceVersionedGraphs workspaceId={wsId} workspaceName={workspace.name} onStagedChange={setVgStaged}
                            onOpenDataSources={() => goTo('data', 'sources')} />
                    </Suspense>
                </div>
            )}

            {/* ── People (RBAC) ───────────────────────────── */}
            {activeTab === 'members' && canAddMembers && wsId && (
                <WorkspaceMembers workspaceId={wsId} canManage={canManageMembers} />
            )}

            {activeTab === 'activity' && activityScope && (
                <div className="py-4">
                    <ActivityExplorer scope={activityScope} />
                </div>
            )}

            {/* ── Settings — how the workspace behaves ─────── */}
            {activeTab === 'settings' && wsId && (
                <WorkspaceSettingsTab
                    wsId={wsId}
                    identityProperty={workspace.identityProperty}
                    nameProperty={workspace.nameProperty}
                    canEditIdentity={canManageDataSources}
                    versioningEnabled={versioningEnabled}
                    onOpenVersionedGraphs={() => goTo('versioned-graphs')}
                    onSaved={reload}
                />
            )}

            {/* ── Modals ──────────────────────────────────── */}
            {reasonPrompt}
            <AddDataSourceWizard
                isOpen={showAddDs}
                workspaceId={wsId ?? ''}
                workspaceName={workspace?.name}
                onClose={() => setShowAddDs(false)}
                onAdded={reload}
                catalogItems={allowedCatalogItems}
                providers={providers}
                ontologies={ontologies}
                onMoveWithViews={item => {
                    if (!wsId || !item.boundWorkspaceId || !item.boundDataSourceId) return
                    setMoving({
                        sourceWorkspace: { id: item.boundWorkspaceId, name: item.boundWorkspaceName ?? 'another workspace' },
                        dataSource: { id: item.boundDataSourceId, label: item.name },
                        presetDestinationId: wsId,
                    })
                }}
            />

            {moving && (
                <MoveDataSourceWizard
                    isOpen
                    {...moving}
                    onClose={() => setMoving(null)}
                    onDone={() => { reload(); setTrashKey(k => k + 1) }}
                />
            )}

            {/* One dialog, two registers. Removing is disruptive but REVERSIBLE, so it shows the
                full blast radius and then asks for nothing but a click — and the notification carries an
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
                tagSuggestions={tagSuggestions}
                onShowDataRequests={dataRequestsOn ? showDataRequests : undefined}
                ds={selectedDs}
                isOpen={!!selectedDsId && !!selectedDs}
                wsId={wsId!}
                stats={selectedDsId ? dsStatsMap[selectedDsId] : undefined}
                providerInfo={selectedDsId ? dsProviderMap[selectedDsId] : undefined}
                ontologyName={selectedDsId ? ontologyNameMap[selectedDs?.ontologyId || ''] : undefined}
                ontologyId={selectedDs?.ontologyId}
                viewCount={selectedDsId ? viewsOn(selectedDsId) : undefined}
                readiness={selectedDsId ? readinessMap[selectedDsId] : undefined}
                ontologies={ontologies}
                onSaveEdit={handleEditDsSave}
                onDelete={workspace.dataSources.length > 1 && selectedDs && !isFork
                    ? () => deletion.open(selectedDs.id, selectedDs.label || selectedDs.id)
                    : undefined}
                onDeletePermanent={workspace.dataSources.length > 1 && selectedDs && !isFork
                    ? () => deletion.openPermanent(selectedDs.id, selectedDs.label || selectedDs.id)
                    : undefined}
                // Moving its views is a workspace admin's call; a source with nothing
                // built on it moves for whoever manages data sources in both places.
                // The server decides either way, and the wizard says why when it won't.
                onMove={selectedDs && !isFork && wsId && (canManageMembers
                    || (canManageDataSources && !!viewCountByDs && !viewCountByDs[selectedDs.id])
                    // In the Playground a graph's maker takes it out, or asks to (the server
                    // knows whose it is; the wizard says so to anyone else).
                    || (workspace.kind === 'playground' && canManageDataSources))
                    ? () => {
                        setMoving({
                            sourceWorkspace: { id: wsId, name: workspace.name },
                            dataSource: {
                                id: selectedDs.id,
                                label: selectedDs.label || dsProviderMap[selectedDs.id]?.catalogItemName || 'this data source',
                            },
                        })
                        // The wizard sits under the drawer's layer, so the drawer steps aside.
                        setSelectedDsId(null)
                    }
                    : undefined}
                onMovedAway={() => { setSelectedDsId(null); reload() }}
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


/** A tab's one plain sentence: what it is for, in the reader's words. */
function TabIntro({ children }: { children: React.ReactNode }) {
    return <p className="py-4 text-sm text-ink-secondary max-w-3xl">{children}</p>
}


// ─────────────────────────────────────────────────────────────────────
// A workspace that can't be opened — it doesn't exist, or you aren't in
// it. A shared link is often how people find a workspace, so this is
// where they can ask to join, whether or not Find a workspace is on. The
// name stays hidden: the server answers with what may be asked for, never
// with what the workspace is.
// ─────────────────────────────────────────────────────────────────────

function WorkspaceUnavailablePanel({
    wsId,
    onNavigateHome,
}: {
    wsId: string
    onNavigateHome: () => void
}) {
    const [asking, setAsking] = useState(false)
    const [requested, setRequested] = useState(false)
    return (
        <div className="flex h-full overflow-y-auto p-6">
            <div className="m-auto max-w-md w-full rounded-2xl border border-glass-border bg-canvas-elevated p-6 text-center">
                <div className="w-12 h-12 rounded-2xl bg-slate-500/10 border border-slate-500/20 flex items-center justify-center mx-auto mb-4">
                    <ShieldOff className="w-6 h-6 text-slate-500" />
                </div>
                <h2 className="text-lg font-bold text-ink">You can’t open this workspace</h2>
                <p className="text-sm text-ink-muted mt-2">
                    It doesn’t exist, or you aren’t in it yet. If someone shared a link with
                    you, ask to join — its admins decide.
                </p>
                <div className="mt-5 flex flex-col gap-2">
                    {requested ? (
                        <p className="text-xs text-emerald-600 dark:text-emerald-400">
                            Request sent. You’ll hear in your Inbox.
                        </p>
                    ) : (
                        <button
                            onClick={() => setAsking(true)}
                            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 text-white text-sm font-semibold shadow-md"
                        >
                            <Send className="w-4 h-4" />
                            Request access
                        </button>
                    )}
                    <button
                        onClick={onNavigateHome}
                        className="w-full px-4 py-2 rounded-xl text-sm font-semibold text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    >
                        Go to workspaces
                    </button>
                </div>
            </div>
            {asking && (
                <RequestAccessDialog
                    workspaceId={wsId}
                    onClose={() => setAsking(false)}
                    onSent={() => setRequested(true)}
                />
            )}
        </div>
    )
}


// ─────────────────────────────────────────────────────────────────────
// Access-revoked panel — rendered when the user had access to this
// workspace earlier in the session but doesn't any more (admin
// revoked their binding while they were on the page). Offers
// "Request access again" (the same dialog as everywhere else), and
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
    const [secondsLeft, setSecondsLeft] = useState(REDIRECT_AFTER_SECONDS)
    const [requested, setRequested] = useState(false)
    const [asking, setAsking] = useState(false)
    // Pause the countdown if the user is interacting (clicked the
    // request button). Cancelled redirects let the user read the
    // confirmation notification without being yanked away mid-action.
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

    const handleRequest = () => {
        setPaused(true)
        setAsking(true)
    }

    return (
        <div className="flex h-full overflow-y-auto p-6">
            <div className="m-auto max-w-md w-full rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6 text-center">
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
                            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
                        >
                            <Send className="w-4 h-4" />
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
            {asking && (
                <RequestAccessDialog
                    workspaceId={wsId}
                    onClose={() => setAsking(false)}
                    onSent={() => setRequested(true)}
                />
            )}
        </div>
    )
}
