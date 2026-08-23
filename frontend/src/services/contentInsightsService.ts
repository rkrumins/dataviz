/**
 * Usage figures for content the reader is already looking at.
 *
 * Separate from `analyticsService` because it answers a different question for
 * a different audience: not "how is the platform doing" for an operator, but
 * "is anyone using this?" for whoever built the thing. It carries no
 * identities, so it needs none of the dashboard's privacy machinery — the
 * server scopes it by the same read rule the catalogue lists with.
 *
 * Batched by design. One request per screen, not one per card.
 */
import { authFetch } from './apiClient'

export interface ViewUsage {
    viewId: string
    opens: number
    uniqueViewers: number
    /** ISO instant, or null when nothing opened it in the window. */
    lastOpenedAt: string | null
    /** Opens per bucket, aligned to the window — sparkline-shaped. */
    trend: number[]
    windowDays: number
}

const ENDPOINT = '/api/v1/insights/views'

/** Usage for many views at once. Ids the caller cannot read come back absent,
 *  which is also what a non-existent id does — so a caller cannot use this to
 *  probe for what exists. */
export async function getViewUsage(
    viewIds: string[], days: number,
): Promise<Record<string, ViewUsage>> {
    if (viewIds.length === 0) return {}
    const body = await authFetch<{ views: Record<string, ViewUsage> }>(
        `${ENDPOINT}?ids=${encodeURIComponent(viewIds.join(','))}&days=${days}`,
        // A view page must not be interrupted because a decoration was
        // refused — the badge simply does not render.
        { silent403: true },
    )
    return body.views ?? {}
}
