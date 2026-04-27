/**
 * useJob — live job-progress overlay via Server-Sent Events.
 *
 * Subscribes to ``GET /api/v1/admin/data-sources/{dsId}/aggregation-jobs/{jobId}/events``
 * and accumulates the latest ``progress`` / ``state`` / ``terminal`` event
 * fields into a local snapshot. Returned to the caller alongside connection
 * status; consumers (JobRow) merge the overlay onto the polling-derived
 * job object so the UI reflects mid-batch progress without a full refetch.
 *
 * Reconnection is browser-managed (``EventSource`` reconnects automatically
 * with the last received ``id`` in the ``Last-Event-ID`` header). The
 * backend's ``XRANGE`` backfill closes any gap; if MAXLEN truncation has
 * dropped events older than the reconnect cursor, the consumer emits a
 * synthetic ``resync`` event which we surface as ``needsResync=true`` so
 * the caller can refetch via REST.
 *
 * Phase 1 scope: one EventSource per row. With HTTP/1.1's 6-conn-per-
 * origin cap this limits us to ~6 visible running rows per browser tab,
 * which is fine in practice. Phase 3's ``useJobsLive(scope)`` collapses
 * this to one EventSource per workspace.
 */
import { useEffect, useRef, useState } from 'react'

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
        const source = new EventSource(url, { withCredentials: true })

        const onOpen = () => {
            setState((prev) => ({ ...prev, connected: true }))
        }

        const onError = () => {
            // Browser auto-reconnects via EventSource. Reflect the
            // disconnected state so the caller can show a "live
            // updates unavailable" badge while polling fallback owns
            // the source of truth.
            setState((prev) => ({ ...prev, connected: false }))
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

            setState((prev) => ({
                connected: true,
                needsResync: prev.needsResync && parsed.type !== 'state',
                terminal: parsed.type === 'terminal',
                snapshot: { ...prev.snapshot, ...next },
            }))
        }

        source.addEventListener('open', onOpen)
        source.addEventListener('error', onError as EventListener)
        // SSE event types — we register listeners for the named events
        // the backend produces. ``message`` is the catchall for events
        // without a named ``event:`` line.
        for (const type of ['state', 'progress', 'phase', 'terminal', 'resync', 'message'] as const) {
            source.addEventListener(type, handleEvent as EventListener)
        }

        return () => {
            source.close()
            acceptedSeq.current = -1
        }
    }, [dataSourceId, jobId, enabled])

    return state
}
