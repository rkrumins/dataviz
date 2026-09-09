/**
 * The limits and scan shape in force on a job, what is left of the time
 * limits, and the patches the Adjust control sends — pure, so the control
 * and the "extend all running" fan-out cannot disagree about what "+3 h" or
 * "Pace ×2" means.
 *
 * Bounds mirror the server's `JobLimitsPatch`: the stall window and wall
 * clock go up to seven days; the per-query budgets 5-600 s; pacing 0-10;
 * read concurrency 1-4; the scan width up to five million rows.
 */
import type { AggregationJobResponse, JobLimitsPatch, LiveLimitChange } from '@/services/aggregationService'

export const MAX_WINDOW_SECS = 604_800
export const DEFAULT_STALL_SECS = 10_800
export const DEFAULT_WALL_SECS = 86_400
export const DEFAULT_PACING = 1
export const DEFAULT_CONCURRENCY = 1
export const DEFAULT_SCAN_WIDTH = 200_000
export const DEFAULT_REPLICA_ACK = 1
export const MAX_PACING = 10

export interface LimitsInForce {
    stallSecs: number
    wallSecs: number
    scanTimeoutS: number | null
    writeTimeoutS: number | null
}

/** What the job is running under right now: the row's values, then the run record, then the defaults. */
export function limitsInForce(job: AggregationJobResponse): LimitsInForce {
    const eff = job.runStats?.effective_tuning
    const live = job.liveOverrides ?? undefined
    const stallSecs = job.timeoutSecs ?? eff?.stall_timeout_secs ?? DEFAULT_STALL_SECS
    const wallBase = live?.max_wall_secs ?? eff?.max_wall_secs ?? DEFAULT_WALL_SECS
    return {
        stallSecs,
        wallSecs: Math.max(wallBase, stallSecs),
        scanTimeoutS: live?.scan_timeout_s ?? eff?.scan_timeout_s ?? null,
        writeTimeoutS: live?.write_timeout_s ?? eff?.write_timeout_s ?? null,
    }
}

/** Seconds left of the stall window (since the last checkpoint) and the wall clock (since start); null when unknown. */
export function secondsLeft(job: AggregationJobResponse, now: number = Date.now()): { stall: number | null; wall: number | null } {
    const { stallSecs, wallSecs } = limitsInForce(job)
    const sinceCheckpoint = job.lastCheckpointAt ? (now - Date.parse(job.lastCheckpointAt)) / 1000 : null
    const sinceStart = job.startedAt ? (now - Date.parse(job.startedAt)) / 1000 : null
    return {
        stall: sinceCheckpoint != null && Number.isFinite(sinceCheckpoint) ? Math.max(0, stallSecs - sinceCheckpoint) : null,
        wall: sinceStart != null && Number.isFinite(sinceStart) ? Math.max(0, wallSecs - sinceStart) : null,
    }
}

/** "+N h" on the stall window, capped at seven days; the wall clock follows when it would otherwise be lower. */
export function extendStallPatch(job: AggregationJobResponse, hours: number): JobLimitsPatch {
    const { stallSecs, wallSecs } = limitsInForce(job)
    const timeoutSecs = Math.min(MAX_WINDOW_SECS, stallSecs + Math.round(hours * 3600))
    return timeoutSecs > wallSecs
        ? { timeoutSecs, maxWallSecs: Math.min(MAX_WINDOW_SECS, timeoutSecs) }
        : { timeoutSecs }
}

/** Double the wall clock, capped at seven days. */
export function doubleWallPatch(job: AggregationJobResponse): JobLimitsPatch {
    const { wallSecs } = limitsInForce(job)
    return { maxWallSecs: Math.min(MAX_WINDOW_SECS, wallSecs * 2) }
}

/** A patch for the per-query budgets, only the ones that changed. */
export function perQueryPatch(job: AggregationJobResponse, scanTimeoutS: number | null, writeTimeoutS: number | null): JobLimitsPatch {
    const cur = limitsInForce(job)
    const clamp = (v: number) => Math.max(5, Math.min(600, v))
    const out: JobLimitsPatch = {}
    if (scanTimeoutS != null && Number.isFinite(scanTimeoutS) && clamp(scanTimeoutS) !== cur.scanTimeoutS) out.scanTimeoutS = clamp(scanTimeoutS)
    if (writeTimeoutS != null && Number.isFinite(writeTimeoutS) && clamp(writeTimeoutS) !== cur.writeTimeoutS) out.writeTimeoutS = clamp(writeTimeoutS)
    return out
}

export interface ShapeInForce {
    /** Sleep-after-write ratio; 0 = no pacing. */
    pacingRatio: number
    /** How many read scans run at once. */
    extractConcurrency: number
    /** The scan width the job runs with — a live cap, else its setting. */
    scanWidth: number
    /** The width the pressure ladder has narrowed to right now, when it has. */
    scanWidthNow: number | null
    /** Replicas of the write node that must confirm each batch; 0 = none. */
    replicaAckMin: number
    /** Which of these are live changes on this run. */
    live: { pacing: boolean; concurrency: boolean; scanWidth: boolean; replicaAck: boolean }
}

/** The scan shape the job is running with: live changes first, then the run record, then the defaults. */
export function shapeInForce(job: AggregationJobResponse): ShapeInForce {
    const eff = job.runStats?.effective_tuning
    const live = job.liveOverrides ?? undefined
    const now = job.runStats?.adapted?.scan_width
    return {
        pacingRatio: live?.write_pacing_ratio ?? eff?.write_pacing_ratio ?? DEFAULT_PACING,
        extractConcurrency: live?.extract_concurrency ?? eff?.extract_concurrency ?? DEFAULT_CONCURRENCY,
        scanWidth: live?.scan_width ?? eff?.scan_range_width ?? DEFAULT_SCAN_WIDTH,
        scanWidthNow: typeof now === 'number' ? now : null,
        replicaAckMin: live?.replica_ack_min ?? eff?.replica_ack_min ?? DEFAULT_REPLICA_ACK,
        live: {
            pacing: live?.write_pacing_ratio != null,
            concurrency: live?.extract_concurrency != null,
            scanWidth: live?.scan_width != null,
            replicaAck: live?.replica_ack_min != null,
        },
    }
}

/** Multiply the pacing in force (a disabled pacing counts as 1×), capped at the bound. */
export function pacePatch(job: AggregationJobResponse, factor: number): JobLimitsPatch {
    const base = shapeInForce(job).pacingRatio
    const next = Math.round((base > 0 ? base : DEFAULT_PACING) * factor * 100) / 100
    return { writePacingRatio: Math.min(MAX_PACING, next) }
}

/** One read scan at a time from the next wave. */
export function serialReadsPatch(): JobLimitsPatch {
    return { extractConcurrency: 1 }
}

/** Cap the scan width at half of what the job scans with right now (the ladder's narrowed width when it has one). */
export function halveScansPatch(job: AggregationJobResponse): JobLimitsPatch {
    const s = shapeInForce(job)
    const base = s.scanWidthNow != null ? Math.min(s.scanWidthNow, s.scanWidth) : s.scanWidth
    return { scanWidth: Math.max(1, Math.floor(base / 2)) }
}

/** Wait for one more replica of the write node to confirm each batch — the
 *  control for a rebuild that is outrunning the store's replicas. */
export function waitForReplicasPatch(job: AggregationJobResponse): JobLimitsPatch {
    return { replicaAckMin: Math.min(5, shapeInForce(job).replicaAckMin + 1) }
}

/** Stop waiting for replicas — releases a run held behind a lagging replica. */
export function releaseReplicaWaitPatch(): JobLimitsPatch {
    return { replicaAckMin: 0 }
}

/** Clear every live shape change — back to the job's settings. */
export function backToSettingsPatch(): JobLimitsPatch {
    return { reset: ['writePacingRatio', 'extractConcurrency', 'scanWidth', 'replicaAckMin'] }
}

export function formatWindow(seconds: number): string {
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`
    const h = seconds / 3600
    if (h < 24) return `${h % 1 === 0 ? h : h.toFixed(1)} h`
    const d = h / 24
    return `${d % 1 === 0 ? d : d.toFixed(1)} d`
}

const FIELD_LABEL: Record<string, string> = {
    timeout_secs: 'stall window',
    max_wall_secs: 'wall clock',
    scan_timeout_s: 'scan timeout',
    write_timeout_s: 'write timeout',
    write_pacing_ratio: 'write pacing',
    extract_concurrency: 'read concurrency',
    scan_width: 'scan width',
    replica_ack_min: 'replica acknowledgement',
    replica_ack_timeout_ms: 'replica ack timeout',
}

const SHAPE_FIELDS = new Set([
    'write_pacing_ratio', 'extract_concurrency', 'scan_width',
    'replica_ack_min', 'replica_ack_timeout_ms',
])

/** One history entry as a sentence: "ops@x raised the stall window 3 h → 6 h", "ops@x set the write pacing 1× → 2×". */
export function describeChange(entry: LiveLimitChange): string {
    const label = FIELD_LABEL[entry.field] ?? entry.field
    const fmt = (v: number | null | undefined) => {
        if (v == null) return SHAPE_FIELDS.has(entry.field) ? 'the job’s setting' : 'default'
        switch (entry.field) {
            case 'scan_timeout_s': case 'write_timeout_s': return `${v} s`
            case 'write_pacing_ratio': return `${v}×`
            case 'extract_concurrency': return `${v} at a time`
            case 'scan_width': return `${v.toLocaleString()} rows`
            case 'replica_ack_min': return v === 0 ? 'no wait' : `${v} replica${v === 1 ? '' : 's'}`
            case 'replica_ack_timeout_ms': return `${v} ms`
            default: return formatWindow(v)
        }
    }
    const who = entry.by ?? 'An operator'
    if (entry.to == null && entry.from != null) return `${who} cleared the ${label} (${fmt(entry.from)} → ${fmt(entry.to)})`
    const verb = SHAPE_FIELDS.has(entry.field)
        ? 'set'
        : entry.from != null && entry.to != null && entry.to < entry.from ? 'lowered' : 'raised'
    return `${who} ${verb} the ${label} ${fmt(entry.from)} → ${fmt(entry.to)}`
}
