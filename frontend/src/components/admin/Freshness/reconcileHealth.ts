/**
 * Sweep liveness and overnight-ledger grouping — the predicates the pulse
 * and blotter share with their tests.
 *
 * Threshold is 3× the resolved check interval, matching the stats service's
 * own staleness rule. One missed sweep is a hiccup; three is an outage.
 */
import type { ReconcileActivityItem, ReconcileRun } from '@/services/freshnessService'
import { toUtcDate } from '@/lib/timeAgo'

/** Matches the sweeper ``_SCAN_CAP`` — a manual pass will not exceed this. */
export const RECONCILE_SCAN_CAP = 200

export const DRIFT_WINDOWS = [
    { key: '1h', label: '1h' },
    { key: '3h', label: '3h' },
    { key: '12h', label: '12h' },
    { key: '24h', label: '24h' },
    { key: '7d', label: '7d' },
] as const

export type DriftWindow = (typeof DRIFT_WINDOWS)[number]['key']

const WINDOW_PHRASE: Record<DriftWindow, string> = {
    '1h': 'the last hour',
    '3h': 'the last 3 hours',
    '12h': 'the last 12 hours',
    '24h': 'the last 24 hours',
    '7d': 'the last 7 days',
}

export function parseDriftWindow(raw: string | null | undefined): DriftWindow {
    return DRIFT_WINDOWS.some(w => w.key === raw) ? (raw as DriftWindow) : '24h'
}

export function windowPhrase(window: DriftWindow): string {
    return WINDOW_PHRASE[window]
}

/** Always fetch the week; chips filter client-side so recency never follows fwin. */
export const ACTIVITY_HORIZON: DriftWindow = '7d'

const WINDOW_MS: Record<DriftWindow, number> = {
    '1h': 1 * 60 * 60 * 1000,
    '3h': 3 * 60 * 60 * 1000,
    '12h': 12 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
}

/** Finding instant for recency — prefer the event ts, else the sweep start. */
export function findingAt(item: ReconcileActivityItem): string | null {
    return item.ts ?? item.runStartedAt ?? null
}

/** Newest finding across the activity payload, or null when the week is empty. */
export function lastDriftAt(items: ReconcileActivityItem[]): string | null {
    let newest: string | null = null
    let newestMs = -Infinity
    for (const item of items) {
        const at = findingAt(item)
        const d = toUtcDate(at)
        if (!d) continue
        const ms = d.getTime()
        if (ms > newestMs) {
            newestMs = ms
            newest = at
        }
    }
    return newest
}

/** Slice the week-long activity payload down to the selected chip window. */
export function itemsInWindow(
    items: ReconcileActivityItem[],
    window: DriftWindow,
    nowMs: number = Date.now(),
): ReconcileActivityItem[] {
    const cutoff = nowMs - WINDOW_MS[window]
    return items.filter(item => {
        const d = toUtcDate(findingAt(item))
        return d != null && d.getTime() >= cutoff
    })
}

export function lastPassLabel(
    run: Pick<ReconcileRun, 'scanned' | 'findings' | 'actions' | 'bySkip'>,
    fleetTotal?: number | null,
): string {
    const scanned = run.scanned
    const drifted = run.findings
    const bySkip = run.bySkip ?? {}
    const inSync = bySkip.in_sync ?? 0
    const versioned = bySkip.platform_mastered ?? 0
    const statsStale = (bySkip.stats_stale ?? 0) + (bySkip.stats_unhealthy ?? 0)
    const total = fleetTotal ?? scanned
    // An auto tick with nobody due still records a run — that is not
    // "the reconcile set is empty"; it is "nothing was due this tick".
    if (scanned === 0) return 'no sources were due this tick'
    const checked = total > RECONCILE_SCAN_CAP && scanned < total
        ? `${scanned.toLocaleString()} of ${total.toLocaleString()} checked — oldest first`
        : `${scanned.toLocaleString()} of ${Math.max(scanned, total).toLocaleString()} checked`
    const parts = [checked]
    if (versioned > 0) parts.push(`${versioned.toLocaleString()} versioned`)
    if (statsStale > 0) parts.push(`${statsStale.toLocaleString()} stats stale`)
    // Prefer the named in_sync skip tally. Fall back when an older run has
    // no bySkip breakdown so we do not claim scanned − findings are all healthy.
    const syncCount = Object.keys(bySkip).length > 0
        ? inSync
        : Math.max(0, scanned - drifted - versioned - statsStale)
    parts.push(`${syncCount.toLocaleString()} in sync`)
    parts.push(`${drifted.toLocaleString()} drifted`)
    if (run.actions > 0) parts.push(`${run.actions.toLocaleString()} queued`)
    return parts.join(' · ')
}

/**
 * The run the pulse should describe as "last pass" and use for next-check.
 * Prefer an explicit Check now result; otherwise the newest run that actually
 * scanned someone. Empty auto ticks prove liveness elsewhere — they must not
 * reset "next in".
 */
export function pickLastPassRun(
    runs: ReconcileRun[] | undefined,
    lastCheck?: ReconcileRun | null,
): ReconcileRun | undefined {
    if (lastCheck && lastCheck.scanned > 0) return lastCheck
    if (lastCheck && !runs?.some(r => r.scanned > 0)) return lastCheck
    return runs?.find(r => r.scanned > 0)
}

/** Newest run of any kind — empty ticks still prove the sweeper is alive. */
export function pickLatestRun(
    runs: ReconcileRun[] | undefined,
    lastCheck?: ReconcileRun | null,
): ReconcileRun | undefined {
    if (lastCheck) return lastCheck
    return runs?.[0]
}

export function checkNowToast(
    res: {
        skipped?: boolean
        run?: Pick<ReconcileRun, 'scanned' | 'findings' | 'actions' | 'bySkip'> | null
    },
    fleetTotal?: number | null,
): string {
    if (res.skipped) return 'A sweep is already running.'
    if (!res.run || res.run.scanned === 0) return 'No sources in the reconcile set yet.'
    return lastPassLabel(res.run, fleetTotal)
}

export function windowDriftCounts(items: ReconcileActivityItem[]): { drifted: number; rebuilt: number } {
    const ids = new Set(items.map(i => i.dataSourceId))
    return {
        drifted: ids.size,
        rebuilt: items.filter(i => i.outcome === 'rebuilt').length,
    }
}

export function sweepsHaveStopped(
    lastStartedAt: string | null | undefined,
    intervalSecs: number | null | undefined,
): boolean {
    if (!lastStartedAt) return false
    const interval = intervalSecs && intervalSecs > 0 ? intervalSecs : 3600
    const ageSecs = (Date.now() - new Date(lastStartedAt).getTime()) / 1000
    return Number.isFinite(ageSecs) && ageSecs >= interval * 3
}

export function nextCheckAt(
    lastStartedAt: string | null | undefined,
    intervalSecs: number | null | undefined,
): Date | null {
    if (!lastStartedAt) return null
    const interval = intervalSecs && intervalSecs > 0 ? intervalSecs : 3600
    const t = new Date(lastStartedAt).getTime()
    if (!Number.isFinite(t)) return null
    return new Date(t + interval * 1000)
}

export function formatHorizon(ms: number): string {
    const abs = Math.abs(ms)
    const mins = Math.max(0, Math.round(abs / 60_000))
    if (mins < 60) return `${mins}m`
    const hours = Math.round(mins / 60)
    if (hours < 48) return `${hours}h`
    return `${Math.round(hours / 24)}d`
}

export function policyWord(
    enabled: boolean | null | undefined,
    envEnabled: boolean,
): 'Watching' | 'Detecting only' {
    return (enabled ?? envEnabled) ? 'Watching' : 'Detecting only'
}

export interface LedgerGroup {
    runId: string
    startedAt: string | null
    mode: string
    items: ReconcileActivityItem[]
}

export function groupLedgerBySweep(items: ReconcileActivityItem[]): LedgerGroup[] {
    const order: string[] = []
    const map = new Map<string, ReconcileActivityItem[]>()
    for (const item of items) {
        if (!map.has(item.runId)) {
            order.push(item.runId)
            map.set(item.runId, [])
        }
        map.get(item.runId)!.push(item)
    }
    return order.map(runId => {
        const groupItems = map.get(runId)!
        return {
            runId,
            startedAt: groupItems[0]?.runStartedAt ?? null,
            mode: groupItems[0]?.mode ?? 'auto',
            items: groupItems,
        }
    })
}
