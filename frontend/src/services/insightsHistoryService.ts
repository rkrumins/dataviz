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
    AlertPolicy,
    AlertPolicyUpdate,
    CountAlertsResponse,
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
            // silent403: history is admin-gated, but the card that reads it
            // sits on a profile plenty of non-admins can open. A permission
            // modal over a page they are entitled to see would be the app
            // shouting about a section it should simply not have shown.
            { signal, silent403: true },
        )
    },

    getProviderHistory(
        providerId: string,
        query: HistoryQuery = {},
        signal?: AbortSignal,
    ): Promise<Envelope<ProviderHistoryPayload>> {
        return authFetch<Envelope<ProviderHistoryPayload>>(
            `${BASE}/providers/${encodeURIComponent(providerId)}/history${qs(query)}`,
            { signal, silent403: true },
        )
    },

    /** Platform-wide totals, one series per provider. */
    getFleetHistory(
        query: HistoryQuery = {},
        signal?: AbortSignal,
    ): Promise<Envelope<ProviderHistoryPayload>> {
        return authFetch<Envelope<ProviderHistoryPayload>>(
            `${BASE}/history/fleet${qs(query)}`, { signal, silent403: true },
        )
    },

    /** URL for the CSV export — always the RAW series, never downsampled.
     *  Returned as a URL rather than fetched because the browser's own
     *  download machinery handles the filename and the save dialog, and the
     *  session cookie rides along. Grain is stripped: an export is evidence,
     *  and evidence is not bucketed to fit a chart. */
    exportUrl(dataSourceId: string, query: HistoryQuery = {}): string {
        // Only the window travels; grain is deliberately dropped rather than
        // forwarded.
        const range: HistoryQuery = { from: query.from, to: query.to }
        return `${BASE}/data-sources/${encodeURIComponent(dataSourceId)}/history.csv${qs(range)}`
    },

    /** Recorded anomalies — fleet-wide, or scoped to one source. Accepts a
     *  catalog id wherever a data source id is expected, like the history
     *  reads do. */
    listAlerts(
        options: { dataSourceId?: string; openOnly?: boolean; limit?: number } = {},
        signal?: AbortSignal,
    ): Promise<CountAlertsResponse> {
        const params = new URLSearchParams()
        if (options.dataSourceId) params.set('dataSourceId', options.dataSourceId)
        if (options.openOnly) params.set('openOnly', 'true')
        if (options.limit) params.set('limit', String(options.limit))
        const q = params.toString()
        return authFetch<CountAlertsResponse>(
            `${BASE}/alerts${q ? `?${q}` : ''}`, { signal, silent403: true },
        )
    },

    acknowledgeAlert(alertId: string): Promise<unknown> {
        return authFetch(
            `${BASE}/alerts/${encodeURIComponent(alertId)}/acknowledge`,
            { method: 'POST' },
        )
    },

    getAlertPolicy(): Promise<AlertPolicy> {
        return authFetch<AlertPolicy>(`${BASE}/alerts/policy`)
    },

    setAlertPolicy(update: AlertPolicyUpdate): Promise<AlertPolicy> {
        return authFetch<AlertPolicy>(`${BASE}/alerts/policy`, {
            method: 'PUT',
            body: JSON.stringify(update),
        })
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
