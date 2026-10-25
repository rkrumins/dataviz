/**
 * Where an event points: the screens that hold what it changed.
 *
 * Every link is built from fields the event carries — never guessed from its
 * summary — and lands on a screen that already accepts it as a deep link, so
 * following one opens the run, the source or the group itself rather than a
 * list to hunt through.
 */
import { jobHistoryPath } from '@/components/admin/job-history/shared'
import { serviceAccountHref } from '@/lib/serviceAccounts'
import type { ActivityEvent } from '@/services/activityService'

export interface ActivityLink {
    key: string
    label: string
    href: string
}

/** A person's own access drawer on the user list — defined beside the chip
 *  that draws people, so every surface links a person the same way; and
 *  `accountHref`, which sends a service account to its own page instead. */
export { accountHref, personHref } from '@/components/ui/PersonChip'

const text = (value: unknown): string | null =>
    typeof value === 'string' && value ? value : null

export function activityLinks(event: ActivityEvent): ActivityLink[] {
    const links: ActivityLink[] = []
    const target = event.target ?? {}
    const jobId = text(event.details?.jobId)

    if (jobId) {
        links.push({
            key: 'job',
            label: 'Open the run in Job History',
            href: jobHistoryPath({ dataSourceId: event.dataSourceId ?? undefined, search: jobId }),
        })
    }
    // An aggregation run someone started: the rest of the runs they started,
    // which answers "how often does this person do this?" in one click.
    if (event.eventType.startsWith('aggregation.') && event.actorKind === 'user' && event.actor?.id) {
        links.push({
            key: 'their-runs',
            label: 'Runs this person started',
            href: jobHistoryPath({ triggeredBy: event.actor.id }),
        })
    }
    if (event.dataSourceId) {
        links.push({
            key: 'freshness',
            label: 'Open the source in Freshness',
            href: `/ingestion?tab=freshness&fds=${encodeURIComponent(event.dataSourceId)}`,
        })
    }
    if (target.type === 'group' && target.id) {
        links.push({
            key: 'group',
            label: 'Open the group',
            href: `/admin/groups?group=${encodeURIComponent(target.id)}`,
        })
    }
    if (target.type === 'service_account' && target.id) {
        links.push({ key: 'service-account', label: 'Open the service account', href: serviceAccountHref(target.id) })
    }
    if (target.type === 'view' && target.id) {
        links.push({ key: 'view', label: 'Open the view', href: `/views/${encodeURIComponent(target.id)}` })
    }
    if (target.type === 'provider') {
        links.push({ key: 'providers', label: 'Open Providers', href: '/ingestion?tab=providers' })
    }
    if (target.type === 'feature_flag') {
        links.push({ key: 'features', label: 'Open Features', href: '/admin/features' })
    }
    if (event.workspaceId) {
        links.push({
            key: 'workspace',
            label: 'Open the workspace',
            href: `/workspaces/${encodeURIComponent(event.workspaceId)}`,
        })
    }
    return links
}
