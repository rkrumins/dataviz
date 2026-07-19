/**
 * Telemetry admin service — read aggregated product-usage signals.
 *
 * Backs the Admin → Telemetry analytics panel. The backend rolls up
 * "was this helpful?" votes, zero-result searches (content gaps), and
 * product-tour completion over a trailing day-window. Gated behind
 * ``system:audit:read`` server-side (same class of read as the audit log).
 */
import { authFetch } from './apiClient'


const TELEMETRY_API = '/api/v1/admin/telemetry/summary'


/** One page's helpful/unhelpful tally. ``page`` is a namespaced key —
 *  ``docs:<slug>`` or ``guide:<slug>``. */
export interface HelpfulByPage {
    page: string
    yes: number
    no: number
}


/** "Was this helpful?" rollup across the window. */
export interface HelpfulSummary {
    yes: number
    no: number
    total: number
    /** Ratio in [0, 1] — yes / total. */
    score: number
    byPage: HelpfulByPage[]
}


/** A search that returned no results, and how often it was asked. */
export interface ContentGap {
    query: string
    count: number
}


/** One tour's funnel: how many finished vs. bailed, and where they bailed. */
export interface TourFunnelRow {
    tourId: string
    completed: number
    skipped: number
    /** completed + skipped — the number of times the tour was started. */
    starts: number
    /** completed / starts, or null when never started. */
    completionRate: number | null
    /** Skip counts by the step index users bailed at, ascending. */
    dropoff: { step: number; count: number }[]
}

/** Product-tour engagement. */
export interface ToursSummary {
    completed: number
    skipped: number
    /** Optional — absent from summaries produced before the funnel was added. */
    funnel?: TourFunnelRow[]
}


export interface TelemetrySummary {
    helpful: HelpfulSummary
    contentGaps: ContentGap[]
    tours: ToursSummary
    totalEvents: number
    windowDays: number
}


export const telemetryAdminService = {
    /** Fetch the usage rollup over the trailing ``days`` window. */
    getSummary(days = 30): Promise<TelemetrySummary> {
        return authFetch<TelemetrySummary>(`${TELEMETRY_API}?days=${days}`)
    },
}
