/**
 * Reads over `/api/v1/profiling`.
 *
 * Every read sends a WINDOW TOKEN (`30d`) rather than an absolute range, and
 * the server returns the bounds it resolved. That is not a convenience: a
 * client computing `to = new Date()` on every render produces a new value each
 * time, which is a query key that never matches its predecessor — the previous
 * implementation re-fetched forever behind a spinner because of exactly this,
 * and freezing the range at mount only traded the loop for a window that could
 * never move forward.
 */
import { authFetch } from './apiClient'
import type {
    BoardPayload,
    FindingsPayload,
    ObservationsPayload,
    ProfilingBreakdown,
    ProfilingGrain,
    ProfilingMetric,
    ProfilingPolicy,
    ProfilingScope,
    SeriesPayload,
} from '@/types/profiling'

const BASE = '/api/v1/profiling'

interface Wrapped<T> { data: T }

export interface SeriesQuery {
    scope: ProfilingScope
    id?: string | null
    window?: string
    from?: string
    to?: string
    grain?: ProfilingGrain
    metric?: ProfilingMetric
    breakdown?: ProfilingBreakdown
    top?: number
    compare?: boolean
}

function qs(params: Record<string, unknown>): string {
    const search = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
        if (value === undefined || value === null || value === '') return
        search.set(key, String(value))
    })
    const s = search.toString()
    return s ? `?${s}` : ''
}

/**
 * `silent403` throughout the READS.
 *
 * Profiling appears inside surfaces plenty of people can open without holding
 * an Ingestion permission. A global access-denied modal over a page someone is
 * entitled to see is the app shouting about a section it should simply not
 * have rendered. The MUTATIONS deliberately omit it: someone who pressed a
 * button and was refused has asked a question and deserves the answer.
 */
export const profilingService = {
    getSeries(q: SeriesQuery, signal?: AbortSignal): Promise<SeriesPayload> {
        return authFetch<Wrapped<SeriesPayload>>(
            `${BASE}/series${qs({ ...q, id: q.id ?? undefined })}`,
            { signal, silent403: true },
        ).then((r) => r.data)
    },

    getBoard(
        q: {
            window?: string; from?: string; to?: string
            workspaceId?: string | null; providerId?: string | null
            metric?: ProfilingMetric; unusualOnly?: boolean
            limit?: number; offset?: number
        },
        signal?: AbortSignal,
    ): Promise<BoardPayload> {
        return authFetch<Wrapped<BoardPayload>>(
            `${BASE}/sources${qs({
                ...q,
                workspaceId: q.workspaceId ?? undefined,
                providerId: q.providerId ?? undefined,
            })}`,
            { signal, silent403: true },
        ).then((r) => r.data)
    },

    getObservations(
        q: {
            id: string; window?: string; from?: string; to?: string
            onlyNotable?: boolean; limit?: number; offset?: number
        },
        signal?: AbortSignal,
    ): Promise<ObservationsPayload> {
        return authFetch<Wrapped<ObservationsPayload>>(
            `${BASE}/observations${qs(q)}`, { signal, silent403: true },
        ).then((r) => r.data)
    },

    getFindings(
        q: { id?: string | null; openOnly?: boolean; limit?: number; offset?: number },
        signal?: AbortSignal,
    ): Promise<FindingsPayload> {
        return authFetch<Wrapped<FindingsPayload>>(
            `${BASE}/alerts${qs({ ...q, id: q.id ?? undefined })}`,
            { signal, silent403: true },
        ).then((r) => r.data)
    },

    acknowledge(findingId: string): Promise<unknown> {
        return authFetch(
            `${BASE}/alerts/${encodeURIComponent(findingId)}/acknowledge`,
            { method: 'POST' },
        )
    },

    getPolicy(signal?: AbortSignal): Promise<ProfilingPolicy> {
        return authFetch<Wrapped<ProfilingPolicy>>(
            `${BASE}/policy`, { signal, silent403: true },
        ).then((r) => r.data)
    },

    setPolicy(patch: Record<string, unknown>): Promise<ProfilingPolicy> {
        return authFetch<Wrapped<ProfilingPolicy>>(`${BASE}/policy`, {
            method: 'PUT',
            body: JSON.stringify(patch),
        }).then((r) => r.data)
    },

    /** Deliberately a URL rather than a fetch: the browser's own download is
     *  the right mechanism, and streaming a CSV through fetch only to
     *  re-materialise it as a blob buys nothing. */
    exportUrl(q: SeriesQuery): string {
        return `${BASE}/export.csv${qs({ ...q, id: q.id ?? undefined })}`
    },
}
