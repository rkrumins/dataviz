/**
 * The pure half of the Run settings panel: the rows (each knob's value and
 * where it came from), the profile a run's settings match, and the plain
 * sentences for what the pressure ladder changed. Kept out of the component
 * file so it can be imported by JobRow's stat cell and tested directly.
 */
import type {
    AdaptedRunState, AggregationTuning, EffectiveTuningSnapshot,
} from '@/services/aggregationService'
import { CONFIG_PRESETS, presetIdFor } from '@/components/admin/shared/AggregationOverridesForm'
import { formatDuration } from './shared'

export type RowSource = 'job' | 'global' | 'hint' | 'env' | 'frozen'

export interface RunSettingRow {
    key: string
    label: string
    value: string
    source: RowSource
}

export const SOURCE_LABEL: Record<RowSource, string> = {
    job: 'Job override',
    global: 'Fleet default',
    hint: 'Learned from last run',
    env: 'Environment',
    frozen: 'Frozen tuning',
}

export const SOURCE_TONE: Record<RowSource, string> = {
    job: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
    global: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
    hint: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
    env: 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted',
    frozen: 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted',
}

const n = (v: unknown) => (typeof v === 'number' ? v.toLocaleString() : '—')
const secs = (v: unknown) => (typeof v === 'number' ? `${v % 1 === 0 ? v : v.toFixed(1)} s` : '—')
const dur = (v: unknown) => (typeof v === 'number' ? formatDuration(v) : '—')
const storage = (v: unknown) =>
    v === 'auto' ? 'Auto' : v === 'true' || v === true ? 'Full detail' : v === 'false' || v === false ? 'Depth-diagonal' : '—'

/** The rows in the order an operator reads them; a row whose value is absent is skipped. */
const ROW_SPECS: Array<{ key: string; label: string; fmt: (v: unknown) => string; onlyWhen?: (v: unknown) => boolean }> = [
    { key: 'scan_range_width', label: 'Scan range width', fmt: n },
    { key: 'extract_concurrency', label: 'Read concurrency', fmt: n },
    { key: 'scan_shrink_floor', label: 'Scan floor', fmt: v => (typeof v === 'number' ? `${v.toLocaleString()} ${v === 1 ? 'row' : 'rows'}` : '—') },
    { key: 'max_pending_pairs', label: 'Max pending pairs', fmt: n },
    { key: 'flush_mem_pct', label: 'Memory flush', fmt: v => (typeof v === 'number' ? `at ${v}% of the worker limit` : '—') },
    { key: 'write_pacing_ratio', label: 'Write pacing ratio', fmt: v => (typeof v === 'number' ? `×${v}` : '—') },
    { key: 'replica_ack_min', label: 'Replica acknowledgement', fmt: v => (typeof v !== 'number' ? '—' : v === 0 ? 'Not waited for' : `${v} replica${v === 1 ? '' : 's'} per write`) },
    { key: 'apply_chunk', label: 'Apply chunk', fmt: n },
    { key: 'delete_chunk', label: 'Delete chunk', fmt: n },
    { key: 'scan_timeout_s', label: 'Scan timeout', fmt: secs },
    { key: 'write_timeout_s', label: 'Write timeout', fmt: secs },
    { key: 'stall_timeout_secs', label: 'Stall window', fmt: dur },
    { key: 'max_wall_secs', label: 'Wall clock', fmt: dur },
    { key: 'max_retries', label: 'Retries', fmt: n },
    { key: 'shard_reserve_pct', label: 'Shard memory reserve', fmt: v => (typeof v === 'number' ? `${v}%` : '—') },
    { key: 'bytes_per_edge', label: 'Bytes per rollup edge', fmt: v => (typeof v === 'number' ? `${v} B` : '—') },
    { key: 'max_materialized_edges', label: 'Edge ceiling', fmt: v => (typeof v === 'number' ? v.toLocaleString() : 'Shard governs') },
    { key: 'max_cube_edges', label: 'Auto’s cube ceiling', fmt: n },
    { key: 'estimate_margin_pct', label: 'Estimate margin', fmt: v => (typeof v === 'number' ? `${v}%` : '—') },
    { key: 'materialize_fine_pairs', label: 'Rollup storage', fmt: storage },
    { key: 'materialize_leaf_pairs', label: 'Leaf pairs', fmt: v => (v ? 'On' : 'Off') },
    { key: 'ignore_observed', label: 'Ignore last run', fmt: () => 'Yes', onlyWhen: v => v === true },
]

const toCamel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

/**
 * Snake-case pipeline keys → the camelCase tuning keys the presets use.
 * Only the values the JOB set (its frozen tuning) take part: a preset sets a
 * handful of knobs and the form matches on exactly those, so the env-sourced
 * rest of the snapshot must not count against it.
 */
function tuningFromSnapshot(eff: EffectiveTuningSnapshot): AggregationTuning {
    const out: Record<string, unknown> = {}
    const sources = eff.sources ?? {}
    for (const [key, value] of Object.entries(eff)) {
        if (key === 'sources' || value === undefined || sources[key] !== 'job') continue
        out[toCamel(key)] = key === 'materialize_fine_pairs'
            ? (value === 'auto' ? 'auto' : value === 'true' || value === true)
            : value
    }
    return out as AggregationTuning
}

/** The profile a run's settings match, or null for a custom mix. */
export function presetForRun(eff: EffectiveTuningSnapshot | null | undefined): string | null {
    if (!eff || typeof eff.max_retries !== 'number' || typeof eff.stall_timeout_secs !== 'number') return null
    const id = presetIdFor({
        maxRetries: eff.max_retries,
        timeoutMinutes: Math.round(eff.stall_timeout_secs / 60),
        tuning: tuningFromSnapshot(eff),
    })
    return id ? CONFIG_PRESETS.find(p => p.id === id)?.label ?? id : null
}

/**
 * The "Ran with" rows: value plus where it came from. A job-set value that
 * equals the fleet default is labelled as the fleet default — the run did
 * not override anything, it inherited.
 */
export function runSettingsRows(
    eff: EffectiveTuningSnapshot | null | undefined,
    storedGlobal?: AggregationTuning | null,
): RunSettingRow[] {
    if (!eff) return []
    const sources = eff.sources ?? {}
    const rows: RunSettingRow[] = []
    for (const spec of ROW_SPECS) {
        const value = eff[spec.key]
        if (value === undefined) continue
        if (spec.onlyWhen && !spec.onlyWhen(value)) continue
        let source: RowSource = sources[spec.key] === 'hint' ? 'hint' : sources[spec.key] === 'job' ? 'job' : 'env'
        if (source === 'job' && storedGlobal) {
            const global = (storedGlobal as Record<string, unknown>)[toCamel(spec.key)]
            const same = spec.key === 'materialize_fine_pairs'
                ? storage(global) === storage(value)
                : global === value
            if (global !== undefined && global !== null && same) source = 'global'
        }
        rows.push({ key: spec.key, label: spec.label, value: spec.fmt(value), source })
    }
    return rows
}

/** Legacy rows: the frozen tuning a job carried before the record existed. */
export function frozenTuningRows(tuning: Record<string, unknown> | null | undefined): RunSettingRow[] {
    if (!tuning) return []
    const rows: RunSettingRow[] = []
    for (const spec of ROW_SPECS) {
        const value = tuning[spec.key]
        if (value === undefined || value === null) continue
        if (spec.onlyWhen && !spec.onlyWhen(value)) continue
        rows.push({ key: spec.key, label: spec.label, value: spec.fmt(value), source: 'frozen' })
    }
    return rows
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`

/** Clock time of a moment inside the run, in the reader's timezone. */
function atTime(iso: string | undefined): string | null {
    if (!iso) return null
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Plain sentences for what the ladder changed, in the order it happens. */
function mb(n: number): string {
    return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`
}

export function adaptationSentences(
    adapted: AdaptedRunState | null | undefined,
    extra?: { bytesPerEdgeObserved?: number | null },
): string[] {
    const out: string[] = []
    if (adapted?.from_last_run && Object.keys(adapted.from_last_run).length > 0) {
        const parts: string[] = []
        const f = adapted.from_last_run
        if (typeof f.scan_width === 'number') parts.push(`scans at ${f.scan_width.toLocaleString()}`)
        if (f.extract_concurrency !== undefined) parts.push('serial reads')
        if (f.reconcile_strategy === 'keys_only') parts.push('keys-only reconcile')
        if (typeof f.write_batch === 'number') parts.push(`write batch ${f.write_batch.toLocaleString()}`)
        if (typeof f.delete_chunk === 'number') parts.push(`delete chunk ${f.delete_chunk.toLocaleString()}`)
        out.push(`Started from what the last run learned: ${parts.join(', ')}`)
    }
    if (adapted?.scan_width_min != null) {
        const scans = adapted.by_scan ? Object.keys(adapted.by_scan) : []
        const where = scans.length > 0 ? ` (${scans.join(', ')})` : ''
        const shrinks = adapted.scan_shrinks ? ` after ${plural(adapted.scan_shrinks, 'shrink', 'shrinks')}` : ''
        out.push(`Scans narrowed to ${adapted.scan_width_min.toLocaleString()} rows${shrinks}${where}`)
    }
    if (adapted?.extract_concurrency != null && !(adapted.from_last_run && 'extract_concurrency' in adapted.from_last_run)) {
        out.push(`Read concurrency dropped to ${adapted.extract_concurrency}`)
    }
    if (adapted?.reconcile_strategy === 'keys_only' && !(adapted.from_last_run && 'reconcile_strategy' in adapted.from_last_run)) {
        out.push('Reconcile switched to keys-only (two passes)')
    }
    if (adapted?.write_batch_min != null) {
        const shrinks = adapted.write_shrinks ? ` after ${plural(adapted.write_shrinks, 'shrink', 'shrinks')}` : ''
        out.push(`Write batch shrank to ${adapted.write_batch_min.toLocaleString()} rows${shrinks}`)
    }
    if (adapted?.delete_chunk_min != null) {
        out.push(`Delete chunk shrank to ${adapted.delete_chunk_min.toLocaleString()} keys`)
    }
    if (adapted?.timeout_retries) {
        out.push(`${plural(adapted.timeout_retries, 'timeout retry', 'timeout retries')} at the narrowest width`)
    }
    if (adapted?.budget_rechecks) {
        out.push(`Shard re-measured ${adapted.budget_rechecks}× during the apply`)
    }
    if (adapted?.replica_waits || adapted?.replica_holds) {
        const lead = adapted.replica_holds
            ? `Waited for the graph store’s replicas ${plural(adapted.replica_holds, 'time', 'times')}`
            : 'Paced against the graph store’s replicas'
        const detail: string[] = []
        if (typeof adapted.replica_wait_s === 'number' && adapted.replica_wait_s >= 1) {
            detail.push(`${formatDuration(adapted.replica_wait_s)} in total`)
        }
        if (typeof adapted.replica_max_lag_bytes === 'number' && adapted.replica_max_lag_bytes > 0) {
            detail.push(`up to ${mb(adapted.replica_max_lag_bytes / 1024 / 1024)} behind`)
        }
        out.push(detail.length ? `${lead} (${detail.join(', ')})` : lead)
    }
    if (adapted?.store_outage_holds || adapted?.node_restarts?.length) {
        // Not pressure and not a failure: the node the run writes to went
        // away, the run waited, and it carried on at the same width.
        const restarts = adapted.node_restarts ?? []
        const nodes = [...new Set(restarts.map(r => r.endpoint))]
        const where = nodes.length === 1 ? nodes[0] : 'the graph store node'
        const parts: string[] = [
            adapted.store_outage_holds
                ? `Held ${plural(adapted.store_outage_holds, 'time', 'times')} while ${where} was unreachable`
                : `Waited while ${where} was unreachable`,
        ]
        if (typeof adapted.store_outage_s === 'number' && adapted.store_outage_s >= 1) {
            parts.push(`(${formatDuration(adapted.store_outage_s)})`)
        }
        const at = restarts.length ? atTime(restarts[restarts.length - 1].at) : null
        if (at) parts.push(`— it restarted at ${at} and the run resumed from its checkpoint`)
        else if (restarts.length) parts.push('— it restarted and the run resumed from its checkpoint')
        out.push(parts.join(' '))
    }
    if (adapted?.store_holds && Object.keys(adapted.store_holds).length) {
        // The write governor: batches held while the node was outside the
        // envelope a rebuild may write inside — each reason true of the node
        // then and false a little later, so a wait rather than a failure.
        const reasonText: Record<string, string> = {
            fork: 'a fork in flight',
            replica_lost: 'replicas gone',
            replica_lag: 'replicas behind',
            memory: 'memory past the fork line',
            loading: 'the node loading',
        }
        const reasons = Object.entries(adapted.store_holds)
            .map(([kind, n]) => `${reasonText[kind] ?? kind} ${n}×`)
        const count = Object.values(adapted.store_holds).reduce((a, b) => a + b, 0)
        const total = Object.values(adapted.store_hold_s ?? {}).reduce((a, b) => a + b, 0)
        const lead = `Held the next write batch ${plural(count, 'time', 'times')} for the graph store node (${reasons.join(', ')}`
        out.push(total >= 1 ? `${lead}; ${formatDuration(total)} in total)` : `${lead})`)
    }
    if (adapted?.memory_flushes || adapted?.memory_rollups) {
        const parts: string[] = []
        if (adapted.memory_flushes) parts.push(`Flushed ${adapted.memory_flushes}× on worker memory`)
        else parts.push(`Rolled up early ${adapted.memory_rollups}× on worker memory`)
        const peak = typeof adapted.rss_high_water_mb === 'number' ? mb(adapted.rss_high_water_mb) : null
        const limit = typeof adapted.mem_limit_mb === 'number' ? mb(adapted.mem_limit_mb) : null
        if (peak && limit) parts.push(`(peak ${peak} of ${limit})`)
        else if (peak) parts.push(`(peak ${peak})`)
        out.push(parts.join(' '))
    }
    if (adapted?.live && Object.keys(adapted.live).length > 0) {
        const l = adapted.live
        const parts: string[] = []
        if (l.write_pacing_ratio != null) parts.push(l.write_pacing_ratio === 0 ? 'no pacing' : `pacing ${l.write_pacing_ratio}×`)
        if (l.extract_concurrency != null) parts.push(l.extract_concurrency === 1 ? 'serial reads' : `reads ${l.extract_concurrency} at a time`)
        if (l.scan_width != null) parts.push(`scans capped at ${l.scan_width.toLocaleString()} rows`)
        if (l.replica_ack_min != null) parts.push(l.replica_ack_min === 0 ? 'no replica wait' : `waiting for ${l.replica_ack_min} replica${l.replica_ack_min === 1 ? '' : 's'}`)
        if (l.scan_timeout_s != null) parts.push(`scan timeout ${l.scan_timeout_s} s`)
        if (l.write_timeout_s != null) parts.push(`write timeout ${l.write_timeout_s} s`)
        out.push(`Changed while running: ${parts.join(', ')}`)
    }
    if (typeof extra?.bytesPerEdgeObserved === 'number') {
        out.push(`Calibrated ${extra.bytesPerEdgeObserved} B per rollup edge`)
    }
    return out
}
