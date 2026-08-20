/**
 * AnalyticsPage — platform insights: growth, engagement, content, workspaces.
 *
 * Tab state lives in the URL and nowhere else. A `useState` mirrored into
 * `?tab=` is two sources of truth: the Back button restores the URL but not the
 * state, so the highlight and the panel disagree. Deriving the active tab from
 * the search params on every render makes that impossible, and it makes every
 * tab linkable — which matters for a dashboard people quote at each other.
 *
 * The range lives there too, so "our activation rate over 90 days" is a URL you
 * can paste into a message.
 */
import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
    AlertCircle, BarChart3, Boxes, LayoutGrid, Sparkles, TrendingUp, Users,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { PageContainer } from '@/components/layout/PageContainer'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { formatUtc } from '@/lib/timeAgo'
import { useAnalyticsSummary, useWorkspaceAnalytics } from '@/hooks/useAnalytics'
import {
    DEFAULT_RANGE_DAYS, RANGE_PRESETS, RangePicker,
} from '@/components/analytics/RangePicker'
import { AnalyticsSkeleton } from '@/components/analytics/AnalyticsSkeleton'
import { OverviewTab } from '@/components/analytics/OverviewTab'
import { GrowthTab } from '@/components/analytics/GrowthTab'
import { EngagementTab } from '@/components/analytics/EngagementTab'
import { ContentTab } from '@/components/analytics/ContentTab'
import { WorkspacesTab } from '@/components/analytics/WorkspacesTab'
import { WorkspaceInsightsPanel } from '@/components/analytics/WorkspaceInsightsPanel'

type AnalyticsTab = 'overview' | 'growth' | 'engagement' | 'content' | 'workspaces'

interface TabDef {
    id: AnalyticsTab
    label: string
    icon: typeof BarChart3
    desc: string
}

const TABS: TabDef[] = [
    { id: 'overview', label: 'Overview', icon: BarChart3, desc: 'The headline numbers' },
    { id: 'growth', label: 'Growth', icon: TrendingUp, desc: 'Signups, sources, retention cohorts' },
    { id: 'engagement', label: 'Engagement', icon: Users, desc: 'Activity, stickiness, activation funnel' },
    { id: 'content', label: 'Content', icon: LayoutGrid, desc: 'Views, visibility and who builds them' },
    { id: 'workspaces', label: 'Workspaces', icon: Boxes, desc: 'Per-workspace insights and drill-down' },
]

export function AnalyticsPage() {
    const [searchParams, setSearchParams] = useSearchParams()
    useDocumentTitle('Analytics')

    // Derived, never stored. An unknown ?tab= falls back rather than 404ing.
    const rawTab = searchParams.get('tab')
    const activeTab: AnalyticsTab = TABS.some((t) => t.id === rawTab)
        ? (rawTab as AnalyticsTab)
        : 'overview'

    const rawRange = Number(searchParams.get('range'))
    const days = RANGE_PRESETS.some((p) => p.days === rawRange) ? rawRange : DEFAULT_RANGE_DAYS

    const selectedWorkspace = searchParams.get('workspace')

    const patchParams = (patch: Record<string, string | null>) => {
        const next = new URLSearchParams(searchParams)
        for (const [key, value] of Object.entries(patch)) {
            if (value === null) next.delete(key)
            else next.set(key, value)
        }
        setSearchParams(next, { replace: true })
    }

    const summary = useAnalyticsSummary(days)
    // The workspace table is only fetched by the tab that shows it, so four of
    // the five tabs cost one request rather than two.
    const workspaces = useWorkspaceAnalytics(days, activeTab === 'workspaces')

    const generatedAt = useMemo(
        () => (summary.data ? formatUtc(summary.data.generatedAt) : null),
        [summary.data],
    )

    const openWorkspace = (workspaceId: string) => {
        // Jumping from another tab's leaderboard should land somewhere that
        // makes sense once the panel is closed.
        patchParams({ tab: 'workspaces', workspace: workspaceId })
    }

    return (
        <div className="absolute inset-0 flex flex-col animate-in fade-in duration-500">
            <div className="shrink-0">
                <PageContainer gutter="shell" className="pt-8">
                    <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
                                <Sparkles className="w-5 h-5 text-white" />
                            </div>
                            <div>
                                <h1 className="text-xl font-bold text-ink leading-tight">Analytics</h1>
                                <p className="text-[11px] text-ink-muted">
                                    How the platform is growing, and who is using it
                                    {generatedAt && ` · as of ${generatedAt}`}
                                </p>
                            </div>
                        </div>

                        {/* One filter row, above everything it scopes. Every
                            chart, stat and table below re-renders against the
                            same slice, so the numbers always agree. */}
                        <RangePicker
                            days={days}
                            onChange={(next) => patchParams({ range: String(next) })}
                            isFetching={summary.isFetching || workspaces.isFetching}
                        />
                    </div>

                    <div
                        role="tablist"
                        aria-label="Analytics sections"
                        className="flex items-center gap-1 border-b border-glass-border overflow-x-auto"
                    >
                        {TABS.map((tab) => {
                            const Icon = tab.icon
                            const isActive = activeTab === tab.id
                            return (
                                <button
                                    key={tab.id}
                                    role="tab"
                                    aria-selected={isActive}
                                    aria-controls={`analytics-panel-${tab.id}`}
                                    id={`analytics-tab-${tab.id}`}
                                    onClick={() => patchParams({ tab: tab.id })}
                                    title={tab.desc}
                                    className={cn(
                                        'flex items-center gap-2 px-6 py-3 text-sm font-semibold transition-all border-b-2 outline-none whitespace-nowrap focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                        isActive
                                            ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                                            : 'border-transparent text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 rounded-t-xl',
                                    )}
                                >
                                    <Icon className="w-4 h-4" />
                                    {tab.label}
                                </button>
                            )
                        })}
                    </div>
                </PageContainer>
            </div>

            <div
                role="tabpanel"
                id={`analytics-panel-${activeTab}`}
                aria-labelledby={`analytics-tab-${activeTab}`}
                className="flex-1 min-h-0 overflow-y-auto"
            >
                <PageContainer gutter="shell" className="py-6 pb-20">
                    {summary.error ? (
                        <ErrorPanel message={summary.error.message} />
                    ) : summary.isLoading || !summary.data ? (
                        <AnalyticsSkeleton />
                    ) : activeTab === 'overview' ? (
                        <OverviewTab
                            data={summary.data} days={days}
                            isStale={summary.isFetching}
                            onWorkspaceClick={openWorkspace}
                        />
                    ) : activeTab === 'growth' ? (
                        <GrowthTab data={summary.data} days={days} isStale={summary.isFetching} />
                    ) : activeTab === 'engagement' ? (
                        <EngagementTab data={summary.data} days={days} isStale={summary.isFetching} />
                    ) : activeTab === 'content' ? (
                        <ContentTab data={summary.data} days={days} isStale={summary.isFetching} />
                    ) : workspaces.error ? (
                        <ErrorPanel message={workspaces.error.message} />
                    ) : workspaces.isLoading || !workspaces.data ? (
                        <AnalyticsSkeleton />
                    ) : (
                        <WorkspacesTab
                            rows={workspaces.data}
                            days={days}
                            isStale={workspaces.isFetching}
                            selectedId={selectedWorkspace}
                            onSelect={(id) => patchParams({ workspace: id })}
                        />
                    )}
                </PageContainer>
            </div>

            <WorkspaceInsightsPanel
                workspaceId={selectedWorkspace}
                days={days}
                onClose={() => patchParams({ workspace: null })}
            />
        </div>
    )
}

function ErrorPanel({ message }: { message: string }) {
    return (
        <div className="border border-glass-border rounded-xl bg-canvas-elevated p-8 flex flex-col items-center text-center">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-rose-500/20 to-rose-500/0 border border-rose-500/20 flex items-center justify-center mb-4">
                <AlertCircle className="w-6 h-6 text-rose-500" />
            </div>
            <h2 className="text-base font-bold text-ink mb-1">Couldn't load analytics</h2>
            <p className="text-sm text-ink-muted max-w-sm">
                {message || 'The insights service is unavailable right now. Try again in a moment.'}
            </p>
        </div>
    )
}
