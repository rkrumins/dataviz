/**
 * The time limits in force on a job, what is left of them, and the patches
 * the Extend control sends — pure, so the control and the "extend all
 * running" fan-out cannot disagree about what "+3 h" means.
 *
 * Bounds mirror the server's `JobLimitsPatch`: the stall window and wall
 * clock go up to seven days; the per-query budgets 5-600 s.
 */
import type { AggregationJobResponse, JobLimitsPatch, LiveLimitChange } from '@/services/aggregationService'

export const MAX_WINDOW_SECS = 604_800
export const DEFAULT_STALL_SECS = 10_800
export const DEFAULT_WALL_SECS = 86_400

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
}

/** One history entry as a sentence: "ops@x raised the stall window 3 h → 6 h". */
export function describeChange(entry: LiveLimitChange): string {
    const label = FIELD_LABEL[entry.field] ?? entry.field
    const fmt = (v: number | null | undefined) => {
        if (v == null) return 'default'
        return entry.field === 'scan_timeout_s' || entry.field === 'write_timeout_s' ? `${v} s` : formatWindow(v)
    }
    const verb = entry.from != null && entry.to != null && entry.to < entry.from ? 'lowered' : 'raised'
    return `${entry.by ?? 'An operator'} ${verb} the ${label} ${fmt(entry.from)} → ${fmt(entry.to)}`
}
