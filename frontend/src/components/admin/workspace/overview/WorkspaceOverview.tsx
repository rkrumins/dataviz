/**
 * WorkspaceOverview — the workspace's front page.
 *
 * The page used to open on Data Sources: graph databases, node-identity defaults
 * and a drafts policy, before a single view. Most people come to a workspace to
 * USE it — open the views their team relies on — and the people who run it come
 * to see whether anything needs them. So the front page answers both:
 *
 *   * what waits on the reader (reviews, people asking to join, sources that
 *     failed), each with the one place to go;
 *   * for a workspace still being set up, the steps left, ticked from what is
 *     really there;
 *   * the way back into their work — the views they opened and favourited here —
 *     and what everyone else here opens most;
 *   * the workspace at a glance, in words rather than graph counters, and what
 *     changed lately.
 *
 * Everything comes from what the page has already loaded, or from hooks other
 * surfaces already use: no new endpoint.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
    Activity, AlertTriangle, ArrowRightLeft, Clock, Database, Eye, Flame, Gauge, GitPullRequestArrow, History,
    Network, Plus, Shapes, UserPlus, UserX,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'
import { compact } from '@/lib/formatMetric'
import { timeAgo } from '@/lib/timeAgo'
import type { WorkspaceResponse } from '@/services/workspaceService'
import { listViews, type View } from '@/services/viewApiService'
import type { DataSourceReadinessResponse } from '@/services/aggregationService'
import { useRecentViews } from '@/hooks/useRecentViews'
import { useAuthStore } from '@/store/auth'
import { useViewUsage } from '@/hooks/useContentInsights'
import { useRequestsToAnswer } from '@/hooks/useWorkspaceAccess'
import { useReviewInboxCounts, useDraftsWhoseOwnerLeft } from '@/features/versioning/hooks/useVersioning'
import { useWorkspaceTransfers } from '@/features/data-source-transfer/useDataSourceTransfers'
import { WorkspaceActivityFeed } from '@/components/views/WorkspaceActivityFeed'
import { EmptyState } from '@/components/ui/EmptyState'
import { AttentionCard, type AttentionItem } from './AttentionCard'
import { SetupChecklist, type SetupStep } from './SetupChecklist'
import { ViewTile } from './ViewTile'
import { SectionTitle } from './SectionTitle'
import { PlaygroundExperiments } from './PlaygroundExperiments'
import type { DataSection, WorkspaceTab } from '../workspaceTabs'

interface WorkspaceOverviewProps {
    workspace: WorkspaceResponse
    /** Every view in the workspace the reader can open (the page's own list). */
    views: View[]
    readinessMap: Record<string, DataSourceReadinessResponse>
    aggregateStats: { totalNodes: number; totalEdges: number; totalTypes: number; totalViews: number }
    canManageSources: boolean
    canManageMembers: boolean
    canAddMembers: boolean
    versioningEnabled: boolean
    showActivity: boolean
    onGoTo: (tab: WorkspaceTab, section?: DataSection) => void
    onNewView?: () => void
    onAddSource?: () => void
    /** The Playground: start a blank graph (on its sandbox provider). */
    onNewGraph?: (providerId?: string) => void
    /** The Playground: open one of the reader's graphs. */
    onOpenGraph?: (dataSourceId: string) => void
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const ATTENTION_ICONS = {
    reviews: GitPullRequestArrow, access: UserPlus, transfer: ArrowRightLeft, ownerLeft: UserX, source: AlertTriangle,
}

export function WorkspaceOverview({
    workspace, views, readinessMap, aggregateStats, canManageSources, canManageMembers, canAddMembers,
    versioningEnabled, showActivity, onGoTo, onNewView, onAddSource, onNewGraph, onOpenGraph,
}: WorkspaceOverviewProps) {
    const wsId = workspace.id
    const isPlayground = workspace.kind === 'playground'
    const sources = workspace.dataSources

    // ── What waits on the reader ────────────────────────────────────────
    const reviewCounts = useReviewInboxCounts(wsId, versioningEnabled).data?.counts
    const { requests } = useRequestsToAnswer('open', { workspaceId: wsId, enabled: canAddMembers })
    const { transfers } = useWorkspaceTransfers(canManageMembers ? wsId : null, 'open')
    const ownerLeft = useDraftsWhoseOwnerLeft(canManageMembers && versioningEnabled ? wsId : null).data

    const attention: AttentionItem[] = useMemo(() => {
        const out: AttentionItem[] = []
        const asked = reviewCounts?.needs_review ?? 0
        const sentBack = reviewCounts?.sent_back ?? 0
        if (asked + sentBack > 0) {
            out.push({
                key: 'reviews', icon: ATTENTION_ICONS.reviews, tone: 'accent',
                title: asked > 0 ? `${plural(asked, 'review')} waiting for you` : `${plural(sentBack, 'change')} sent back to you`,
                detail: asked > 0 && sentBack > 0 ? `and ${plural(sentBack, 'of yours', 'of yours')} sent back` : undefined,
                actionLabel: 'Open reviews', onAction: () => onGoTo('reviews'),
            })
        }
        const open = requests?.length ?? 0
        if (open > 0) {
            out.push({
                key: 'access', icon: ATTENTION_ICONS.access, tone: 'info',
                title: `${plural(open, 'person', 'people')} asking to join`,
                actionLabel: 'Review requests', onAction: () => onGoTo('members'),
            })
        }
        if (canManageSources) {
            const troubled = sources.filter(ds => {
                const r = readinessMap[ds.id]
                return r?.aggregationStatus === 'failed' || r?.projectorCurrent === false
            })
            if (troubled.length > 0) {
                out.push({
                    key: 'sources', icon: ATTENTION_ICONS.source, tone: 'danger',
                    title: troubled.length === 1
                        ? `“${troubled[0].label || 'A data source'}” needs a look`
                        : `${plural(troubled.length, 'data source')} need a look`,
                    detail: 'Its last refresh didn’t finish, or it is behind its latest changes.',
                    actionLabel: 'Review', onAction: () => onGoTo('data', 'processing'),
                })
            }
        }
        const moving = transfers?.length ?? 0
        if (moving > 0) {
            out.push({
                key: 'transfer', icon: ATTENTION_ICONS.transfer, tone: 'info',
                title: `${plural(moving, 'data source')} waiting to move`,
                detail: 'Into or out of this workspace — accept, decline or cancel.',
                actionLabel: 'Open', onAction: () => onGoTo('data', 'sources'),
            })
        }
        const orphaned = ownerLeft?.length ?? 0
        if (orphaned > 0) {
            out.push({
                key: 'ownerLeft', icon: ATTENTION_ICONS.ownerLeft, tone: 'warning',
                title: `${plural(orphaned, 'draft')} whose owner left`,
                detail: 'Hand each one on so the work isn’t lost.',
                actionLabel: 'Hand on', onAction: () => onGoTo('settings'),
            })
        }
        return out
    }, [reviewCounts, requests, transfers, ownerLeft, sources, readinessMap, canManageSources, onGoTo])

    // ── Setting up a new workspace ──────────────────────────────────────
    const steps: SetupStep[] = [
        {
            id: 'connect', label: 'Connect data', done: sources.length > 0,
            description: 'Bring in the graph this workspace is about.',
            actionLabel: 'Add a source', onAction: onAddSource,
        },
        {
            id: 'model', label: 'Choose a data model', done: sources.some(ds => !!ds.ontologyId),
            description: 'Tell the workspace what kinds of things your data holds.',
            actionLabel: 'Open sources', onAction: () => onGoTo('data', 'sources'),
        },
        {
            id: 'build', label: 'Build its connections',
            done: sources.length > 0 && sources.some(ds => readinessMap[ds.id]?.isReady || readinessMap[ds.id]?.aggregationStatus === 'ready'),
            description: 'Work out how things connect, so lineage opens fast.',
            actionLabel: 'Open processing', onAction: () => onGoTo('data', 'processing'),
        },
        {
            id: 'view', label: 'Create the first view', done: views.length > 0,
            description: 'A view is what people open: a map, a hierarchy or a table of your data.',
            actionLabel: 'New view', onAction: onNewView,
        },
        {
            id: 'invite', label: 'Invite people', done: (workspace.memberCount ?? 0) > 1,
            description: 'Let your team in, as viewers or editors.',
            actionLabel: canAddMembers ? 'Invite' : undefined, onAction: canAddMembers ? () => onGoTo('members') : undefined,
        },
    ]

    // ── Back into the reader's work ─────────────────────────────────────
    const { recent } = useRecentViews()
    const byId = useMemo(() => new Map(views.map(v => [v.id, v])), [views])
    const recentHere = recent.filter(r => r.workspaceId === wsId && byId.has(r.viewId)).slice(0, 4)
    const favourites = views.filter(v => v.isFavourited && !recentHere.some(r => r.viewId === v.id)).slice(0, 4 - Math.min(4, recentHere.length))

    const popularQ = useQuery({
        queryKey: ['workspace-overview', 'popular', wsId],
        queryFn: () => listViews({ workspaceIds: [wsId], sort: 'most-opened', limit: isPlayground ? 8 : 4 }),
        enabled: views.length > 0,
        staleTime: 60_000,
    })
    // In the Playground the reader's own work has its panel: this shelf is everyone else's.
    const me = useAuthStore(s => s.user?.id)
    const popular = (popularQ.data?.items ?? []).filter(v => !isPlayground || v.createdBy !== me).slice(0, 4)
    const usage = useViewUsage(popular.map(v => v.id)).data

    // ── At a glance ─────────────────────────────────────────────────────
    const lastRefreshed = sources
        .map(ds => readinessMap[ds.id]?.lastAggregatedAt ?? ds.lastAggregatedAt ?? null)
        .filter((t): t is string => !!t)
        .sort()
        .at(-1)

    const isManager = canManageSources || canManageMembers

    return (
        <div className="grid gap-5 py-5 xl:grid-cols-3">
            <div className="space-y-5 xl:col-span-2 min-w-0">
                {attention.length > 0 && <AttentionCard items={attention} />}
                {/* The Playground has nothing to set up: it leads with the reader's own experiments. */}
                {isPlayground
                    ? <PlaygroundExperiments workspace={workspace} views={views} onNewGraph={onNewGraph} onOpenGraph={onOpenGraph ?? (() => onGoTo('data', 'sources'))} />
                    : isManager && <SetupChecklist wsId={wsId} steps={steps} />}

                {views.length === 0 ? (isPlayground ? null : (
                    <section className="rounded-3xl border border-dashed border-glass-border bg-canvas-elevated">
                        <EmptyState
                            icon={Eye}
                            title="No views here yet"
                            description={onNewView
                                ? 'A view is how people explore this workspace’s data — a map, a hierarchy or a table. Create the first one.'
                                : 'Views are how people explore this workspace’s data. Once someone creates one, it shows up here.'}
                            action={onNewView ? { label: 'New view', onClick: onNewView, icon: Plus } : undefined}
                        />
                    </section>
                )) : (
                    <>
                        <Shelf title="Jump back in" subtitle="Views you opened or favourited here" onSeeAll={() => onGoTo('views')} icon={History} tone="text-indigo-500 bg-indigo-500/10">
                            {recentHere.length + favourites.length === 0 ? (
                                <p className="col-span-full text-sm text-ink-muted">
                                    Views you open or favourite in this workspace will wait for you here.
                                </p>
                            ) : (
                                <>
                                    {recentHere.map(r => (
                                        <ViewTile key={r.viewId}
                                            view={{ id: r.viewId, name: r.viewName, viewType: r.viewType, dataSourceName: r.dataSourceName, favourite: byId.get(r.viewId)?.isFavourited }}
                                            meta={`Opened ${timeAgo(r.visitedAt)}`} />
                                    ))}
                                    {favourites.map(v => (
                                        <ViewTile key={v.id} view={{ ...v, favourite: true }} meta="In your favourites" />
                                    ))}
                                </>
                            )}
                        </Shelf>

                        <Shelf
                            title={isPlayground ? 'Shared by others' : 'Popular here'}
                            subtitle={isPlayground ? 'What people in the Playground open most — open one for ideas' : 'What people in this workspace open most'}
                            onSeeAll={() => onGoTo('views')} icon={Flame} tone="text-amber-500 bg-amber-500/10"
                        >
                            {popular.map(v => {
                                const u = usage?.[v.id]
                                return (
                                    <ViewTile key={v.id} view={v}
                                        meta={u && u.opens > 0
                                            ? `${compact(u.opens)} opens · ${plural(u.uniqueViewers, 'person', 'people')}`
                                            : 'Not opened lately'} />
                                )
                            })}
                        </Shelf>
                    </>
                )}
            </div>

            <aside className="space-y-5 min-w-0">
                {attention.length === 0 && <AttentionCard items={[]} />}

                <section aria-labelledby="glance-title" className="rounded-3xl border border-glass-border bg-canvas-elevated p-5">
                    <SectionTitle id="glance-title" icon={Gauge} tone="text-violet-500 bg-violet-500/10" title="At a glance" className="mb-4" />
                    <div className="grid grid-cols-2 gap-3">
                        <Fact icon={Eye} tone="text-cyan-500 bg-cyan-500/10" label="Views" value={String(views.length)} onClick={() => onGoTo('views')} />
                        <Fact icon={Database} tone="text-indigo-500 bg-indigo-500/10" label="Connected sources" value={String(sources.length)} onClick={() => onGoTo('data', 'sources')} />
                        <Fact icon={Shapes} tone="text-violet-500 bg-violet-500/10" label="Things tracked" value={compact(aggregateStats.totalNodes)}
                            hint="Every entity across this workspace’s data — tables, columns, systems, people…" />
                        <Fact icon={Network} tone="text-emerald-500 bg-emerald-500/10" label="Connections" value={compact(aggregateStats.totalEdges)}
                            hint="Every relationship between them — lineage, containment, ownership…" />
                    </div>
                    <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-muted">
                        <Clock className="w-3.5 h-3.5" aria-hidden />
                        {lastRefreshed ? `Connections last refreshed ${timeAgo(lastRefreshed)}` : 'Connections not built yet'}
                    </p>
                </section>

                <section aria-labelledby="activity-title" className="rounded-3xl border border-glass-border bg-canvas-elevated p-5">
                    <SectionTitle
                        id="activity-title" icon={Activity} tone="text-sky-500 bg-sky-500/10" title="Recent changes" className="mb-2"
                        action={showActivity ? (
                            <button type="button" onClick={() => onGoTo('activity')} className="shrink-0 text-xs font-semibold text-accent-lineage hover:underline">See all</button>
                        ) : undefined}
                    />
                    <WorkspaceActivityFeed workspaceId={wsId} />
                </section>
            </aside>
        </div>
    )
}

function Shelf({ title, subtitle, onSeeAll, icon, tone, children }: {
    title: string
    subtitle: string
    onSeeAll: () => void
    icon: ComponentType<{ className?: string }>
    tone: string
    children: React.ReactNode
}) {
    return (
        <section aria-label={title}>
            <SectionTitle
                icon={icon} tone={tone} title={title} subtitle={subtitle} className="mb-3"
                action={<button type="button" onClick={onSeeAll} className="shrink-0 text-xs font-semibold text-accent-lineage hover:underline">All views</button>}
            />
            <div className="grid gap-2.5 sm:grid-cols-2">{children}</div>
        </section>
    )
}

function Fact({ icon: Icon, tone, label, value, hint, onClick }: {
    icon: ComponentType<{ className?: string }>
    tone: string
    label: string
    value: string
    hint?: string
    onClick?: () => void
}) {
    const body = (
        <>
            <span className={cn('w-8 h-8 rounded-xl flex items-center justify-center shrink-0', tone)}><Icon className="w-4 h-4" aria-hidden /></span>
            <span className="min-w-0 text-left">
                <span className="block text-lg font-bold tabular-nums leading-tight text-ink">{value}</span>
                <span className="block text-[11px] text-ink-muted">{label}</span>
            </span>
        </>
    )
    const cls = 'flex items-center gap-2.5 rounded-2xl p-2 -m-2'
    return onClick ? (
        <button type="button" onClick={onClick} title={hint} className={cn(cls, 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40')}>{body}</button>
    ) : (
        <div title={hint} className={cls}>{body}</div>
    )
}
