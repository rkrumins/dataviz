/**
 * ActivityExplorer — who did what, where, when and why.
 *
 * One component, mounted twice: Admin → Activity for auditors (the whole
 * platform), and a workspace's Activity tab for its admins (that workspace's
 * workspace-audience events, enforced by the server). The scope decides the
 * endpoint; nothing on screen can widen it.
 *
 * Layout, top to bottom, is the order a reader asks in: the filters (what am
 * I looking at), the insight band (how much, what kind, when, who, why), then
 * the timeline itself, each row opening the event in a drawer. Everything is
 * driven by `act_*` URL params, so any view of the log is a link.
 */
import { useMemo } from 'react'

import {
    useActivityCatalogue,
    useActivityEvents,
    useActivityNewer,
    useActivitySummary,
} from '@/hooks/useActivity'
import { activityService, type ActivityScope } from '@/services/activityService'

import { ActivityEventDrawer } from './ActivityEventDrawer'
import { ActivityFilterBar, type ActivityNames } from './ActivityFilterBar'
import { ActivityInsightBand } from './ActivityInsightBand'
import { ActivityTimeline } from './ActivityTimeline'
import { useActivityParams } from './useActivityParams'

export function ActivityExplorer({ scope }: { scope: ActivityScope }) {
    const params = useActivityParams()
    const catalogue = useActivityCatalogue(scope)
    const summary = useActivitySummary(scope, params.query)
    const timeline = useActivityEvents(scope, params.query)
    const ledger = timeline.ledger
    const newer = useActivityNewer(
        scope, params.query, ledger?.watermark ?? null,
        // History being imported is not news.
        !!ledger && !ledger.backfilling && !timeline.isFetching,
    )
    const workspaceLocked = scope.kind === 'workspace' && !scope.asAuditor

    // A chip names the id it filters on from whatever is on screen; an id
    // nothing on screen names stays an id.
    const names = useMemo<ActivityNames>(() => {
        const out: ActivityNames = {}
        const put = (id?: string | null, name?: string | null) => {
            if (id && name && !out[id]) out[id] = name
        }
        for (const e of timeline.events) {
            put(e.workspaceId, e.workspaceName)
            put(e.dataSourceId, e.dataSourceName)
            put(e.target?.id, e.target?.label)
            put(e.actor?.id, e.actor?.name || e.actor?.email)
        }
        for (const s of summary.data?.handsOnSources ?? []) {
            put(s.dataSourceId, s.name)
            put(s.workspaceId, s.workspaceName)
        }
        for (const t of summary.data?.topTargets ?? []) put(t.id, t.label)
        return out
    }, [timeline.events, summary.data])

    return (
        <div className="space-y-6">
            <ActivityFilterBar
                params={params}
                catalogue={catalogue.data}
                workspaceLocked={workspaceLocked}
                exportHref={activityService.exportUrl(scope, params.query)}
                isFetching={summary.isFetching || timeline.isFetching}
                names={names}
            />
            <ActivityInsightBand
                summary={summary.data}
                isLoading={summary.isLoading}
                isStale={summary.isFetching}
                error={summary.error as Error | null}
                params={params}
            />
            <ActivityTimeline
                events={timeline.events}
                ledger={ledger}
                isLoading={timeline.isLoading}
                isStale={timeline.isPlaceholderData}
                error={timeline.error}
                hasNextPage={timeline.hasNextPage}
                isFetchingNextPage={timeline.isFetchingNextPage}
                onLoadMore={() => { void timeline.fetchNextPage() }}
                onOpen={params.openEvent}
                newer={newer.data ?? null}
                onShowNewer={() => { void timeline.refetch() }}
                onClearFilters={params.activeFilterCount > 0 ? params.clearFilters : undefined}
            />
            <ActivityEventDrawer
                scope={scope}
                eventId={params.eventId}
                onClose={params.closeEvent}
                onOpen={params.openEvent}
            />
        </div>
    )
}
