/**
 * The "Steady load" line on a running job: what the rebuild is doing to the
 * graph store right now, from the pace scalars the heartbeat carries.
 *
 * Three states, one line each. Holding: nothing is being written because the
 * node is outside the envelope a rebuild may write inside — the operator
 * should know WHY, and that it ends on its own. Eased: the node is nearing a
 * hold line, so the run has halved its batches and doubled its pauses.
 * Steady: the shape of the last batch and the rolling duty cycle and rate.
 */
import type { JobLiveOverlay } from '@/hooks/useJob'

export interface SteadyLoadNow {
    batchRows?: number
    batchS?: number
    ackS?: number
    sleepS?: number
    batchMax?: number
    targetS?: number
    ratio?: number
    batches?: number
    dutyPct?: number
    rowsPerS?: number
    replicaLagBytes?: number
    headroomBytes?: number
    holding?: string
    eased?: string
    fork?: string
    /** How many OTHER rebuilds hold a reservation on this graph store node. */
    sharing?: number
}

const HOLD_TEXT: Record<string, string> = {
    fork: 'the graph store node is forked',
    replica_lost: 'a replica the run started with is gone',
    replica_lag: 'a replica is too far behind',
    memory: 'the node is past the memory line',
    loading: 'the node is loading its dataset',
}

const FORK_TEXT: Record<string, string> = {
    bgsave: 'a background save',
    aof_rewrite: 'an AOF rewrite',
    aof_rewrite_scheduled: 'an AOF rewrite about to start',
    replica_sync: 'a replica receiving a full resync',
}

const EASE_TEXT: Record<string, string> = {
    replica_lag: 'replicas half way to the drop limit',
    memory: 'the container’s fork line in sight',
}

/** The pace scalars off a live snapshot, or null when the run has not written yet. */
export function steadyLoadFromSnapshot(snap: JobLiveOverlay['snapshot']): SteadyLoadNow | null {
    const holding = snap.pace_holding || undefined
    if (!holding && !snap.pace_batches) return null
    return {
        batchRows: snap.pace_batch_rows,
        batchS: snap.pace_batch_s,
        ackS: snap.pace_ack_s,
        sleepS: snap.pace_sleep_s,
        batchMax: snap.pace_batch_max,
        targetS: snap.pace_target_s,
        ratio: snap.pace_ratio,
        batches: snap.pace_batches,
        dutyPct: snap.pace_duty_pct,
        rowsPerS: snap.pace_rows_per_s,
        replicaLagBytes: snap.pace_replica_lag_bytes,
        headroomBytes: snap.pace_headroom_bytes,
        holding,
        eased: snap.pace_eased || undefined,
        fork: snap.pace_fork || undefined,
        sharing: snap.pace_sharing,
    }
}

function bytes(n: number): string {
    if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(1)} GB`
    if (n >= 2 ** 20) return `${Math.round(n / 2 ** 20)} MB`
    return `${Math.round(n / 1024)} KB`
}

function seconds(s: number): string {
    return s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(1)} s`
}

export interface SteadyLoadLine {
    tone: 'holding' | 'eased' | 'steady'
    title: string
    detail: string
}

export function steadyLoadLine(now: SteadyLoadNow): SteadyLoadLine {
    if (now.holding) {
        const why = now.holding === 'fork' && now.fork && FORK_TEXT[now.fork]
            ? `${FORK_TEXT[now.fork]} is running on the graph store node`
            : HOLD_TEXT[now.holding] ?? now.holding
        return {
            tone: 'holding',
            title: `Holding — ${why}`,
            detail: 'Nothing is written while the node is outside the envelope a rebuild may write inside. The run waits, keeps its heartbeat, and carries on by itself when the node is back — at half the batch.',
        }
    }
    const shape: string[] = []
    if (typeof now.batchRows === 'number') shape.push(`${now.batchRows.toLocaleString()}-row batches`)
    if (typeof now.batchS === 'number') shape.push(`${seconds(now.batchS)} each`)
    if (typeof now.ackS === 'number' && now.ackS >= 0.05) shape.push(`${seconds(now.ackS)} for the replicas`)
    if (typeof now.sleepS === 'number') shape.push(`${seconds(now.sleepS)} pause`)
    if (typeof now.dutyPct === 'number') shape.push(`${now.dutyPct}% write duty`)
    if (typeof now.rowsPerS === 'number') shape.push(`${Math.round(now.rowsPerS).toLocaleString()} rows/s`)
    if (typeof now.replicaLagBytes === 'number' && now.replicaLagBytes > 0) shape.push(`replicas ${bytes(now.replicaLagBytes)} behind`)
    if (typeof now.headroomBytes === 'number') shape.push(`${bytes(Math.max(0, now.headroomBytes))} headroom`)
    // Why a run on an otherwise healthy node is not at the pacing floor. Two
    // rebuilds each reading the same free memory would each take the floor,
    // and the master would get twice the write rate either asked for — so a
    // shared node gets the configured ceiling from both.
    if (typeof now.sharing === 'number' && now.sharing > 0) {
        shape.push(
            now.sharing === 1
                ? 'sharing the node with another rebuild'
                : `sharing the node with ${now.sharing} other rebuilds`,
        )
    }
    if (now.eased) {
        return {
            tone: 'eased',
            title: `Easing off — ${EASE_TEXT[now.eased] ?? now.eased}`,
            detail: [`batches of at most ${(now.batchMax ?? 0).toLocaleString()} rows and twice the pause until the reading is back`, ...shape].join(' · '),
        }
    }
    return { tone: 'steady', title: 'Steady load', detail: shape.join(' · ') }
}
