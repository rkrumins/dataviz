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
    /** Opens in the window. */
    opens: number
    /**
     * Distinct people in the window — the number that actually answers "can I
     * trust this?". 340 opens by one person is a scratchpad; 340 by twelve is
     * something a team relies on, and the raw total cannot tell them apart.
     */
    uniqueViewers: number
    /** ISO instant, or null when nothing opened it in the window. */
    lastOpenedAt: string | null
    /** Opens per bucket, aligned to the window — sparkline-shaped. */
    trend: number[]
    windowDays: number
    /** Opens for all time. Secondary on purpose: it is largely a proxy for how
     *  long the view has existed, so it belongs in a tooltip, not a ranking. */
    lifetimeOpens: number
    /** The only person who has ever opened this is the person who made it. */
    onlyAuthor: boolean
    /** The reader's own opens in the window. */
    yourOpens: number
    /** When the reader last opened it — reaches back past the window. */
    yourLastOpenedAt: string | null
}

export interface WorkspaceUsage {
    workspaceId: string
    /** Views in the workspace the reader may read. */
    views: number
    opens: number
    uniqueViewers: number
    /** What people actually come here for, or null when nobody has. */
    topView: { viewId: string; name: string; opens: number } | null
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


const WORKSPACE_ENDPOINT = '/api/v1/insights/workspaces'

/** Rollups for many workspaces at once. Covers only the views the reader may
 *  read, so two readers can see different totals for one workspace — the
 *  access rule showing through, not a bug. */
export async function getWorkspaceUsage(
    workspaceIds: string[], days: number,
): Promise<Record<string, WorkspaceUsage>> {
    if (workspaceIds.length === 0) return {}
    const body = await authFetch<{ workspaces: Record<string, WorkspaceUsage> }>(
        `${WORKSPACE_ENDPOINT}?ids=${encodeURIComponent(workspaceIds.join(','))}&days=${days}`,
        { silent403: true },
    )
    return body.workspaces ?? {}
}
