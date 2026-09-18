/**
 * useJob — live job-progress overlay via Server-Sent Events.
 *
 * Subscribes to ``GET /api/v1/admin/data-sources/{dsId}/aggregation-jobs/{jobId}/events``
 * and accumulates the latest ``progress`` / ``state`` / ``terminal`` event
 * fields into a local snapshot. Returned to the caller alongside connection
 * status; consumers (JobRow) merge the overlay onto the polling-derived
 * job object so the UI reflects mid-batch progress without a full refetch.
 *
 * RECONNECTION IS OURS, NOT THE BROWSER'S. ``EventSource`` reconnects by
 * itself, and that was the problem: roughly every 3 seconds, unjittered, for
 * as long as the row is mounted, with no ceiling and no end — and ``onError``
 * only flipped ``connected``, so nothing ever noticed. A control plane that
 * is down therefore gets every running row in every open tab knocking on it
 * three times a minute each, in lockstep, forever. So the stream is CLOSED on
 * error and re-opened on a jittered backoff that widens to a ceiling, and it
 * is closed for good once a ``terminal`` event lands (the durable values come
 * from the polled row after that, so the socket has nothing left to carry).
 *
 * The backend's ``XRANGE`` backfill closes any gap a reconnect leaves; if
 * MAXLEN truncation has dropped events older than the reconnect cursor, the
 * consumer emits a synthetic ``resync`` event which we surface as
 * ``needsResync=true`` so the caller can refetch via REST.
 *
 * CONCURRENCY IS CAPPED HERE, per tab, across every mounted row. The original
 * note said one stream per row was self-limiting because "HTTP/1.1 caps at
 * 6" — which is not true behind an HTTP/2 ingress, where a tab will happily
 * hold a hundred, each one pinning a server-side reader. A row that cannot
 * get a slot simply runs on the polling fallback (which is the source of
 * truth anyway) and tries again later. Phase 3's ``useJobsLive(scope)``
 * collapses this to one EventSource per workspace.
 */
import { useEffect, useRef, useState } from 'react'
import { withJitter } from '@/config/polling'

/**
 * Live streams one tab may hold at once. Beyond this, rows fall back to the
 * 5s job-history poll — which already owns the durable values, so the only
 * thing lost is mid-batch progress on the rows past the cap.
 */
const MAX_CONCURRENT_STREAMS = 4

/** Reconnect backoff: first gap, and the ceiling it widens to. */
const RECONNECT_BASE_MS = 3_000
const RECONNECT_MAX_MS = 60_000

/** How long a row without a free slot waits before asking for one again. */
const SLOT_RETRY_MS = 10_000

/** Streams currently open across every mounted row in this tab. */
let openStreams = 0

export interface JobLiveOverlay {
    /** Whether the EventSource is currently connected. False during the
     *  first-load handshake and during browser-initiated reconnects. */
    connected: boolean
    /** True after a synthetic ``resync`` event landed; the caller should
     *  refetch the job via REST then this flag clears on the next event. */
    needsResync: boolean
    /** True after a ``terminal`` event landed; the caller stops rendering
     *  live counters and reads the durable values from the polling-fetched
     *  job object. */
    terminal: boolean
    /** Live snapshot of fields the platform's ``JobEvent.payload`` /
     *  HSET emit. Sparse — only fields the latest event populated. */
    snapshot: Partial<{
        status: string
        processed_edges: number
        total_edges: number
        created_edges: number
        progress: number
        last_cursor: string
        last_heartbeat_at: string
        currentPhase: string
        writes: number
        deletes: number
        /** What the pressure ladder has changed so far (see AdaptedRunState). */
        adapted_scan_width: number
        adapted_scan_width_min: number
        adapted_scan_shrinks: number
        adapted_extract_concurrency: number
        adapted_reconcile_strategy: string
        adapted_write_batch: number
        adapted_delete_chunk: number
        adapted_timeout_retries: number
        adapted_memory_flushes: number
        adapted_rss_high_water_mb: number
        adapted_mem_limit_mb: number
        /** What an operator changed on the running job, in force now. */
        adapted_live_scan_timeout_s: number
        adapted_live_write_timeout_s: number
        adapted_live_write_pacing_ratio: number
        adapted_live_extract_concurrency: number
        adapted_live_scan_width: number
        /** How the run is writing right now: the last batch, the rolling duty
         *  cycle and rate, whether it is holding or eased and why, and what the
         *  node's last reading said (see steadyLoad.ts). */
        pace_batch_rows: number
        pace_batch_s: number
        pace_ack_s: number
        pace_sleep_s: number
        pace_batch_max: number
        pace_target_s: number
        pace_ratio: number
        pace_batches: number
        pace_rows: number
        pace_duty_pct: number
        pace_rows_per_s: number
        pace_replica_lag_bytes: number
        pace_headroom_bytes: number
        /** Other rebuilds holding a reservation on the same graph store node. */
        pace_sharing: number
        pace_holding: string
        pace_eased: string
        pace_fork: string
    }>
}

const _initial: JobLiveOverlay = {
    connected: false,
    needsResync: false,
    terminal: false,
    snapshot: {},
}

interface JobEvent {
    v: 1
    type: 'state' | 'progress' | 'phase' | 'terminal' | 'resync'
    job_id: string
    kind: string
    scope: { workspace_id: string; data_source_id?: string }
    sequence: number
    ts: string
    payload: Record<string, unknown>
}

function _coerceNumeric(value: unknown): number | undefined {
    if (typeof value === 'number') return value
    if (typeof value === 'string') {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : undefined
    }
    return undefined
}

export function useJob(
    dataSourceId: string,
    jobId: string,
    enabled: boolean = true,
): JobLiveOverlay {
    const [state, setState] = useState<JobLiveOverlay>(_initial)
    // ``acceptedSeq`` ensures we ignore late-arriving lower-sequence
    // events (shouldn't happen with proper ordering, but defensive).
    const acceptedSeq = useRef<number>(-1)

    useEffect(() => {
        if (!enabled || !dataSourceId || !jobId) {
            return
        }
        const url = `/api/v1/admin/data-sources/${encodeURIComponent(dataSourceId)}/aggregation-jobs/${encodeURIComponent(jobId)}/events`

        let cancelled = false
        let source: EventSource | null = null
        let timer: ReturnType<typeof setTimeout> | undefined
        let attempt = 0
        let holdsSlot = false

        const closeSource = () => {
            if (source) {
                source.close()
                source = null
            }
            if (holdsSlot) {
                openStreams -= 1
                holdsSlot = false
            }
        }

        const onOpen = () => {
            attempt = 0
            setState((prev) => ({ ...prev, connected: true }))
        }

        const onError = () => {
            if (cancelled) return
            // Reflect the disconnected state so the caller can show a "live
            // updates unavailable" badge while the polling fallback owns the
            // source of truth — then take the reconnect away from the browser,
            // which retries every ~3s forever, unjittered, per row, per tab.
            setState((prev) => ({ ...prev, connected: false }))
            closeSource()
            attempt += 1
            timer = setTimeout(
                open,
                withJitter(Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS)),
            )
        }

        const handleEvent = (ev: MessageEvent) => {
            let parsed: JobEvent | null = null
            try {
                parsed = JSON.parse(ev.data) as JobEvent
            } catch {
                return
            }
            if (!parsed || parsed.sequence <= acceptedSeq.current) return
            acceptedSeq.current = parsed.sequence

            if (parsed.type === 'resync') {
                setState((prev) => ({ ...prev, needsResync: true }))
                return
            }

            const payload = parsed.payload || {}
            const next: JobLiveOverlay['snapshot'] = {}
            const status = payload['status']
            if (typeof status === 'string') next.status = status
            const processed = _coerceNumeric(payload['processed_edges'])
            if (processed !== undefined) next.processed_edges = processed
            const total = _coerceNumeric(payload['total_edges'])
            if (total !== undefined) next.total_edges = total
            const created = _coerceNumeric(payload['created_edges'])
            if (created !== undefined) next.created_edges = created
            const progress = _coerceNumeric(payload['progress'])
            if (progress !== undefined) next.progress = progress
            const cursor = payload['last_cursor']
            if (typeof cursor === 'string') next.last_cursor = cursor
            const heartbeat = payload['last_heartbeat_at']
            if (typeof heartbeat === 'string') next.last_heartbeat_at = heartbeat
            const phase = payload['current_phase']
            if (typeof phase === 'string') next.currentPhase = phase
            const writes = _coerceNumeric(payload['writes'])
            if (writes !== undefined) next.writes = writes
            const deletes = _coerceNumeric(payload['deletes'])
            if (deletes !== undefined) next.deletes = deletes
            for (const key of [
                'adapted_scan_width', 'adapted_scan_width_min', 'adapted_scan_shrinks',
                'adapted_extract_concurrency', 'adapted_write_batch', 'adapted_delete_chunk',
                'adapted_timeout_retries', 'adapted_memory_flushes', 'adapted_rss_high_water_mb',
                'adapted_mem_limit_mb',
                'adapted_live_scan_timeout_s', 'adapted_live_write_timeout_s', 'adapted_live_write_pacing_ratio',
                'adapted_live_extract_concurrency', 'adapted_live_scan_width',
                'pace_batch_rows', 'pace_batch_s', 'pace_ack_s', 'pace_sleep_s', 'pace_batch_max',
                'pace_target_s', 'pace_ratio', 'pace_batches', 'pace_rows', 'pace_duty_pct',
                'pace_rows_per_s', 'pace_replica_lag_bytes', 'pace_headroom_bytes',
                'pace_sharing',
            ] as const) {
                const v = _coerceNumeric(payload[key])
                if (v !== undefined) next[key] = v
            }
            const strategy = payload['adapted_reconcile_strategy']
            if (typeof strategy === 'string') next.adapted_reconcile_strategy = strategy
            for (const key of ['pace_holding', 'pace_eased', 'pace_fork'] as const) {
                const v = payload[key]
                if (typeof v === 'string') next[key] = v
            }

            setState((prev) => ({
                connected: true,
                needsResync: prev.needsResync && parsed.type !== 'state',
                terminal: parsed.type === 'terminal',
                snapshot: { ...prev.snapshot, ...next },
            }))

            // The run is over and the DB is the source of truth from here, so
            // the stream has nothing left to carry. Left open, it was a socket
            // per finished row plus the browser's reconnect loop behind it.
            if (parsed.type === 'terminal') closeSource()
        }

        const open = () => {
            if (cancelled) return
            if (!holdsSlot) {
                if (openStreams >= MAX_CONCURRENT_STREAMS) {
                    // Every other row in the tab is already streaming. Polling
                    // still has this row; ask again shortly.
                    timer = setTimeout(open, withJitter(SLOT_RETRY_MS))
                    return
                }
                openStreams += 1
                holdsSlot = true
            }
            source = new EventSource(url, { withCredentials: true })
            source.addEventListener('open', onOpen)
            source.addEventListener('error', onError as EventListener)
            // SSE event types — we register listeners for the named events
            // the backend produces. ``message`` is the catchall for events
            // without a named ``event:`` line.
            for (const type of ['state', 'progress', 'phase', 'terminal', 'resync', 'message'] as const) {
                source.addEventListener(type, handleEvent as EventListener)
            }
        }

        open()

        return () => {
            cancelled = true
            if (timer) clearTimeout(timer)
            closeSource()
            acceptedSeq.current = -1
        }
    }, [dataSourceId, jobId, enabled])

    return state
}
