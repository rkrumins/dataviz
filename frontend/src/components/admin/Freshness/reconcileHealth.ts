/**
 * Sweep liveness and overnight-ledger grouping — the predicates the pulse
 * and blotter share with their tests.
 *
 * Threshold is 3× the resolved check interval, matching the stats service's
 * own staleness rule. One missed sweep is a hiccup; three is an outage.
 */
import type { ReconcileActivityItem, ReconcileRun } from '@/services/freshnessService'

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

export function lastPassLabel(
    run: Pick<ReconcileRun, 'scanned' | 'findings' | 'actions'>,
    fleetTotal?: number | null,
): string {
    const scanned = run.scanned
    const drifted = run.findings
    const inStep = Math.max(0, scanned - drifted)
    const total = fleetTotal ?? scanned
    if (scanned === 0) return 'no sources in the reconcile set'
    const checked = total > RECONCILE_SCAN_CAP && scanned < total
        ? `${scanned.toLocaleString()} of ${total.toLocaleString()} checked — oldest first`
        : `${scanned.toLocaleString()} of ${Math.max(scanned, total).toLocaleString()} checked`
    const parts = [checked, `${inStep.toLocaleString()} in step`, `${drifted.toLocaleString()} drifted`]
    if (run.actions > 0) parts.push(`${run.actions.toLocaleString()} queued`)
    return parts.join(' · ')
}

export function checkNowToast(
    res: { skipped?: boolean; run?: Pick<ReconcileRun, 'scanned' | 'findings' | 'actions'> | null },
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
