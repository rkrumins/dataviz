/**
 * A run's whole record as plain text, for a ticket.
 *
 * Everything below is already on the page — across the stage rail, the Run
 * settings disclosure, the advisories and the error block — which is exactly
 * the problem: attaching it to a ticket meant five expanders and a
 * screenshot, and screenshots lose the numbers.
 */
import type { AggregationJobResponse } from '@/services/aggregationService'
import { describeSteps, stageShares } from './runSteps'
import { runSettingsRows } from './runSettings'
import { nodeOf } from './NodeLoad'

const _n = (v: number | null | undefined) =>
    typeof v === 'number' ? v.toLocaleString() : '—'

function _dur(seconds: number | null | undefined): string {
    if (typeof seconds !== 'number' || seconds <= 0) return '—'
    if (seconds < 60) return `${Math.round(seconds)}s`
    const m = Math.floor(seconds / 60)
    const s = Math.round(seconds % 60)
    if (seconds < 3600) return s > 0 ? `${m}m ${s}s` : `${m}m`
    return `${Math.floor(seconds / 3600)}h ${m % 60}m`
}

/**
 * Deliberately plain text rather than JSON: it is pasted into a ticket and
 * read by a person, and `run_stats` verbatim is a wall of keys nobody scans.
 * The ids are all here, so the raw record is always one API call away.
 */
export function runRecordText(
    job: AggregationJobResponse,
    meta?: { label?: string; graphName?: string } | null,
): string {
    const out: string[] = []
    const stats = job.runStats ?? null

    out.push(`Aggregation run ${job.id}`)
    out.push(`  data source   ${meta?.label ?? job.dataSourceLabel ?? job.dataSourceId} (${job.dataSourceId})`)
    if (meta?.graphName) out.push(`  graph         ${meta.graphName}`)
    const node = nodeOf(job)
    if (node) out.push(`  graph store   ${node}`)
    if (job.workerId) out.push(`  worker        ${job.workerId}`)
    out.push(`  status        ${job.status}${job.failureCategory ? ` (${job.failureCategory})` : ''}`)
    out.push(`  trigger       ${job.triggerSource}${job.reconcileReason ? ` — ${job.reconcileReason}` : ''}`)
    out.push(`  started       ${job.startedAt ?? '—'}`)
    out.push(`  finished      ${job.completedAt ?? '—'}`)
    if (job.durationSeconds != null) out.push(`  duration      ${_dur(job.durationSeconds)}`)
    if (job.retryCount) out.push(`  retries       ${job.retryCount} of ${job.maxRetries ?? '—'}`)

    const views = describeSteps(stats?.steps, Date.now())
    if (views.length > 0) {
        const shares = new Map(stageShares(stats?.steps).map(sh => [sh.id, sh.pct]))
        out.push('', 'Stages')
        for (const v of views) {
            const pct = shares.get(v.id)
            out.push(
                `  ${v.label.padEnd(10)} ${v.state.padEnd(9)}`
                + ` ${(v.elapsedS != null ? _dur(v.elapsedS) : '—').padStart(8)}`
                + (pct != null ? ` ${String(Math.round(pct)).padStart(3)}%` : '     ')
                + (v.detail ? `  ${v.detail}` : '')
                + (v.visits > 1 ? `  (entered ${v.visits}×)` : ''),
            )
        }
    }

    if (stats) {
        out.push('', 'Result')
        out.push(`  written       ${_n(stats.writes)}`)
        out.push(`  deleted       ${_n(stats.deletes)}`)
        out.push(`  cube size     ${_n(stats.pairs)}`)
        out.push(`  scanned       ${_n(stats.scanned_edges)}`)
        if (stats.regime) out.push(`  storage       ${stats.regime}`)
        if (stats.cube_estimate != null) out.push(`  estimate      ${_n(stats.cube_estimate)}`)
        const budget = stats.write_budget as Record<string, unknown> | undefined
        if (budget) {
            out.push(`  budget        ${_n(budget.allowed_growth_edges as number)} edges`
                + ` (governed by ${String(budget.governed_by ?? '—')})`)
        }
    }

    const rows = runSettingsRows(stats?.effective_tuning, null)
    if (rows.length > 0) {
        out.push('', 'Ran with')
        for (const row of rows) out.push(`  ${row.label.padEnd(24)} ${row.value}  [${row.source}]`)
    }

    const adapted = stats?.adapted
    if (adapted && Object.keys(adapted).length > 0) {
        out.push('', 'Adapted during the run')
        for (const [key, value] of Object.entries(adapted)) {
            if (value == null || typeof value === 'object') continue
            out.push(`  ${key.padEnd(24)} ${String(value)}`)
        }
    }

    const advisories = stats?.advisories ?? []
    if (advisories.length > 0) {
        out.push('', 'Advisories')
        for (const adv of advisories) {
            out.push(`  [${adv.severity ?? 'warning'}] ${adv.kind}: ${adv.message}`)
        }
    }

    if (job.errorMessage) out.push('', 'Error', `  ${job.errorMessage}`)
    return out.join('\n')
}
