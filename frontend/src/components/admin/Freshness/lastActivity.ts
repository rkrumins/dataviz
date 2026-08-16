/**
 * Last Activity — the last thing that happened, not the current health.
 *
 * Health lives in Freshness (Up to date, Out of memory, Drifting, …).
 * This column names the action: a reconcile check, a rebuild, a refresh.
 * Check now / auto sweeps update ``lastCheckedAt`` without a refresh_event,
 * so the table must not rely on ``lastEvent`` alone.
 */
import type { FreshnessRow, RefreshEventSummary } from '@/services/freshnessService'

export type LastActivityKind =
    | 'in_step'
    | 'verdict'
    | 'rebuild'
    | 'refresh'
    | 'failed'
    | 'queued'

export type LastActivitySource = 'check' | 'event'

export interface LastActivity {
    kind: LastActivityKind
    label: string
    /** Origin shown on the pill — Reconcile / API / Drift — never tooltip-only. */
    originLabel: string | null
    at: string
    /** Drives the TimeStamp prefix: ``checked`` vs ``updated``. */
    source: LastActivitySource
}

const RECONCILE_ORIGINS = new Set(['reconcile', 'reconcile-sweep', 'drift'])

export function activityOriginLabel(origin: string): string {
    switch (origin) {
        case 'api': return 'API'
        case 'reconcile':
        case 'reconcile-sweep': return 'Reconcile'
        case 'drift': return 'Drift'
        case 'script': return 'Script'
        case 'onboarding': return 'Onboarding'
        case 'schedule': return 'Schedule'
        case 'manual': return 'Manual'
        default: return origin.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())
    }
}

function ms(iso: string | null | undefined): number {
    if (!iso) return Number.NEGATIVE_INFINITY
    const t = new Date(iso).getTime()
    return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY
}

function reconcileCheck(at: string): LastActivity {
    return {
        kind: 'in_step',
        label: 'Reconcile check',
        originLabel: 'Reconcile',
        at,
        source: 'check',
    }
}

/** Map one refresh_event to the action the fleet table shows. */
export function activityFromEvent(ev: RefreshEventSummary): LastActivity {
    const origin = activityOriginLabel(ev.origin)
    const outcome = (ev.outcome || '').toLowerCase()
    const reconcile = RECONCILE_ORIGINS.has(ev.origin)

    if (reconcile) {
        if (outcome === 'noop') {
            return { kind: 'in_step', label: 'Reconcile check', originLabel: origin, at: ev.ts, source: 'event' }
        }
        if (outcome === 'accepted') {
            return { kind: 'queued', label: 'Rebuild queued', originLabel: origin, at: ev.ts, source: 'event' }
        }
        if (outcome === 'failed' || outcome === 'error') {
            return { kind: 'failed', label: 'Rebuild failed', originLabel: origin, at: ev.ts, source: 'event' }
        }
        return { kind: 'rebuild', label: 'Rebuild done', originLabel: origin, at: ev.ts, source: 'event' }
    }

    if (outcome === 'accepted') {
        return { kind: 'queued', label: 'Refresh queued', originLabel: origin, at: ev.ts, source: 'event' }
    }
    if (outcome === 'failed' || outcome === 'error') {
        return { kind: 'failed', label: 'Refresh failed', originLabel: origin, at: ev.ts, source: 'event' }
    }
    return { kind: 'refresh', label: 'Refresh done', originLabel: origin, at: ev.ts, source: 'event' }
}

/** Newest of lastEvent vs lastCheckedAt, named as an action. */
export function resolveLastActivity(row: Pick<
    FreshnessRow,
    'lastEvent' | 'lastCheckedAt'
>): LastActivity | null {
    const eventMs = ms(row.lastEvent?.ts)
    const checkedMs = ms(row.lastCheckedAt)

    if (eventMs < 0 && checkedMs < 0) return null

    if (checkedMs > eventMs && row.lastCheckedAt) {
        return reconcileCheck(row.lastCheckedAt)
    }
    if (row.lastEvent) return activityFromEvent(row.lastEvent)
    if (row.lastCheckedAt) return reconcileCheck(row.lastCheckedAt)
    return null
}
