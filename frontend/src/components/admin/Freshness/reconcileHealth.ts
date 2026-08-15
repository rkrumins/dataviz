/**
 * Sweep liveness and overnight-ledger grouping — the predicates the pulse
 * and blotter share with their tests.
 *
 * Threshold is 3× the resolved check interval, matching the stats service's
 * own staleness rule. One missed sweep is a hiccup; three is an outage.
 */
import type { ReconcileActivityItem } from '@/services/freshnessService'

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
