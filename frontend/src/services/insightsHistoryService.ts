/**
 * Historical entity counts — reads over `data_source_count_snapshots`.
 *
 * Unlike the rest of the insights surface these are NOT cache-only reads of a
 * volatile row: the snapshots are durable and append-only, and nothing the
 * frontend does can make more of them appear. The `{ data, meta }` envelope is
 * kept anyway so `StatusChip`, `useBackendRecovery` and the polling machinery
 * behave identically across every insights read.
 *
 * Mirrors `CountHistoryPayload` / `ProviderHistoryPayload` in
 * `backend/app/api/v1/endpoints/insights.py`, and `HistoryRetentionResponse`
 * in `backend/app/api/v1/endpoints/platform_settings.py`. Envelope fields are
 * snake_case, like every other insights payload.
 */
import { authFetch } from './apiClient'
import type {
    Envelope,
    CountHistoryPayload,
    HistoryRetentionPolicy,
    HistoryRetentionUpdate,
    ProviderHistoryPayload,
} from '@/types/insights'

const BASE = '/api/v1/admin/insights'
const SETTINGS = '/api/v1/admin/platform/history-retention'

/** Grain the caller wants. `auto` lets the backend pick from the window
 *  width — the right default, since the point count that stays readable is a
 *  property of the window, not of the reader. */
export type HistoryGrain = 'auto' | 'raw' | 'hour' | 'day'

export interface HistoryQuery {
    from?: string
    to?: string
    grain?: HistoryGrain
}

function qs(query: HistoryQuery): string {
    const params = new URLSearchParams()
    if (query.from) params.set('from', query.from)
    if (query.to) params.set('to', query.to)
    if (query.grain) params.set('grain', query.grain)
    const s = params.toString()
    return s ? `?${s}` : ''
}

export const insightsHistoryService = {
    getDataSourceHistory(
        dataSourceId: string,
        query: HistoryQuery = {},
        signal?: AbortSignal,
    ): Promise<Envelope<CountHistoryPayload>> {
        return authFetch<Envelope<CountHistoryPayload>>(
            `${BASE}/data-sources/${encodeURIComponent(dataSourceId)}/history${qs(query)}`,
            { signal },
        )
    },

    getProviderHistory(
        providerId: string,
        query: HistoryQuery = {},
        signal?: AbortSignal,
    ): Promise<Envelope<ProviderHistoryPayload>> {
        return authFetch<Envelope<ProviderHistoryPayload>>(
            `${BASE}/providers/${encodeURIComponent(providerId)}/history${qs(query)}`,
            { signal },
        )
    },

    getRetention(): Promise<HistoryRetentionPolicy> {
        return authFetch<HistoryRetentionPolicy>(SETTINGS)
    },

    /** Partial update. Omit a field to leave it alone; send `-1` to clear it
     *  back to the env default — see `HistoryRetentionRequest` on the backend
     *  for why the sentinel is a number and not `null`. */
    setRetention(update: HistoryRetentionUpdate): Promise<HistoryRetentionPolicy> {
        return authFetch<HistoryRetentionPolicy>(SETTINGS, {
            method: 'PUT',
            body: JSON.stringify(update),
        })
    },
}

/** Sentinel meaning "clear this override and inherit the env default". */
export const INHERIT_ENV_DEFAULT = -1
