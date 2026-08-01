/**
 * View API Service — First-class view persistence (de-coupled from Context Models).
 *
 * Views are visual renderings stored in the `views` table.
 * `View.config` stores the FULL `ViewConfiguration` — no lossy conversion needed.
 *
 * API scope: /api/v1/views (top-level, cross-workspace)
 */
import type { ViewVisibility } from '@/lib/viewVisibility'
import type { LayerAssignmentEntry, ViewConfiguration, ViewLayerConfig } from '@/types/schema'
import { authFetch } from './apiClient'

// ============================================
// Types
// ============================================

/**
 * The caller's capabilities on ONE view, computed server-side by the
 * same evaluator that enforces every request. Present only on the
 * single-view read (never in list payloads). UI gating flows through
 * `deriveViewCapabilities` in `@/lib/viewAccess` — do not re-derive
 * these from permission claims.
 */
export interface ViewAccess {
    canEdit: boolean
    canManageGrants: boolean
    canChangeVisibility: boolean
    /** Already accounts for the workspace's publish policy — an `open`
     *  workspace grants this to anyone who can change visibility. */
    canPublish: boolean
    /** Can't publish, but may ASK someone who can. This is what turns the
     *  Enterprise tile from a wall into a route. Absent on backends that
     *  predate the request flow. */
    canRequestPublish?: boolean
    /** Holds the publish permission, so may approve/deny a pending request. */
    canAnswerPublishRequest?: boolean
    /** How this caller reaches the view. */
    accessVia: 'owner' | 'admin' | 'grant' | 'workspace' | 'enterprise'
    /** What the DATA plane accepts: 'full' = graph mutations allowed;
     *  'readonly' = view-capability reach (expand/trace/search only). */
    dataAccess: 'full' | 'readonly'
}

/**
 * A pending ask to publish this view platform-wide. Present on the
 * single-view read AND on list payloads (the workspace governance
 * surface lists every view awaiting an answer).
 */
export interface ViewPublishRequest {
    requestedBy: string
    /** Resolved server-side from the users table; null for a deleted user. */
    requestedByName?: string | null
    requestedAt: string
    note?: string | null
}

/**
 * Whether a view's workspace + data source are still present and
 * active. Computed SERVER-side: only the server can tell "you're not a
 * member of that workspace" apart from "it was deleted", which is why
 * the old client-side computation branded every shared view
 * "Source deleted".
 */
export interface ViewHealth {
    status: 'healthy' | 'warning' | 'broken' | 'stale'
    reason?: string | null
}

export interface View {
    id: string
    name: string
    description?: string
    contextModelId?: string
    contextModelName?: string
    workspaceId: string
    workspaceName?: string
    dataSourceId?: string
    dataSourceName?: string
    viewType: string
    /**
     * Top-level projection of `config.layoutType` — lets metadata-only
     * consumers (ViewWizard scope resolver) decide which schema scope to
     * fetch WITHOUT parsing the full config blob.
     */
    layoutType?: string
    config: Record<string, any>    // Full ViewConfiguration shape
    visibility: ViewVisibility
    createdBy?: string
    /** Human-readable creator name resolved server-side from the users table. */
    createdByName?: string
    /** Creator's email, surfaced for tooltip / hover detail. */
    createdByEmail?: string
    /** Id of the user who last edited the view. Null until the first post-migration edit. */
    updatedBy?: string | null
    /** Human-readable editor name resolved server-side from the users table. */
    updatedByName?: string | null
    /** Editor's email, surfaced for tooltip / hover detail. */
    updatedByEmail?: string | null
    /** When/who last changed the view's UNDERLYING DATA (publish / PR merge on its
     *  data source) — separate from updatedAt/updatedBy (settings edits) so both
     *  stories stay truthful. Null until the first post-migration publish. */
    dataUpdatedAt?: string | null
    dataUpdatedBy?: string | null
    dataUpdatedByName?: string | null
    dataUpdatedByEmail?: string | null
    tags?: string[]
    isPinned: boolean
    favouriteCount: number
    isFavourited: boolean
    createdAt: string
    updatedAt: string
    deletedAt?: string | null
    /**
     * Ontology digest captured when the view was last saved. Used by the
     * wizard to detect ontology drift: if this differs from the current
     * workspace ontology digest, the UI surfaces a non-blocking warning.
     * Nullable for views created before drift tracking landed.
     */
    ontologyDigest?: string | null
    /** Provider behind the view's (server-resolved) data source. Single-view
     *  read only — lets the canvas boot without the workspace list. */
    providerId?: string | null
    /** Caller-specific capability envelope. Single-view read only. */
    access?: ViewAccess | null
    /** Scope integrity, computed server-side (see ViewHealth). */
    health?: ViewHealth | null
    /** A pending ask to publish this view to everyone. Null when none. */
    publishRequest?: ViewPublishRequest | null
}

export interface ViewCreateRequest {
    name: string
    description?: string
    contextModelId?: string
    workspaceId: string
    dataSourceId?: string
    viewType?: string
    config?: Record<string, any>
    visibility?: string
    tags?: string[]
    isPinned?: boolean
}

export interface ViewUpdateRequest {
    name?: string
    description?: string
    contextModelId?: string
    viewType?: string
    config?: Record<string, any>
    // NB: no `visibility` — the generic PUT rejects it (422). Visibility
    // is a security field with its own authorization (publish gate);
    // change it only through `updateViewVisibility`.
    tags?: string[]
    isPinned?: boolean
}

export interface ViewListParams {
    visibility?: string
    /** Multi-visibility filter; wins over single ``visibility`` when both are set. */
    visibilityIn?: string[]
    workspaceId?: string
    /** Multi-workspace filter; wins over single ``workspaceId`` when both are set. */
    workspaceIds?: string[]
    contextModelId?: string
    dataSourceId?: string
    viewType?: string
    /** Multi-viewType filter; wins over single ``viewType`` when both are set. */
    viewTypes?: string[]
    /** Restrict to views authored by a specific user (used by "My Views"). */
    createdBy?: string
    /** Multi-creator filter; wins over single ``createdBy`` when both are set. */
    createdByIn?: string[]
    /** ISO timestamp — returns views created on or after this time. */
    createdAfter?: string
    search?: string
    /** OR semantics: match views whose tags array contains ANY of these. */
    tags?: string[]
    /** Server-side ordering key (recently-modified | data-newest | data-oldest |
     *  newest | oldest | updated | popular | az | za). Ordered across the whole
     *  result so it stays correct with infinite scroll. */
    sort?: string
    limit?: number
    offset?: number
    /** Return only views the current user has bookmarked/favourited. */
    favouritedOnly?: boolean
    /** Include soft-deleted views in the results. */
    includeDeleted?: boolean
    /** Return only soft-deleted views. */
    deletedOnly?: boolean
    /** Return only views that need attention (stale, broken, or inactive). */
    attentionOnly?: boolean
    /**
     * Server-side category. `shared-with-me` = views shared with the
     * caller through an explicit grant (direct or via group), excluding
     * their own — a real answer, not a visibility approximation.
     */
    category?: string
    /**
     * Embedded resources the server should fold into the response.
     * ``"popular"`` makes the response carry ``popular`` (the trending
     * strip) so the Explorer needs one round-trip instead of two.
     */
    include?: ('popular')[]
    /** Cap on the embedded ``popular`` list. Only honoured with ``include: ['popular']``. */
    popularLimit?: number
}

/**
 * Paginated envelope returned by ``GET /api/v1/views/``.
 *
 * ``total`` is the authoritative count of matches; ``hasMore`` and
 * ``nextOffset`` are pre-computed on the server so callers don't have
 * to infer pagination state from ``items.length >= limit``.
 */
export interface ViewListResponse {
    items: View[]
    total: number
    hasMore: boolean
    nextOffset: number | null
    /**
     * Embedded trending strip — present iff the caller passed
     * ``include: ['popular']``. Lets the Explorer get its list + popular
     * in one round-trip instead of two.
     */
    popular?: View[]
}

/** A single facet value with its row count. */
export interface ViewFacetValue {
    value: string
    count: number
}

/** A creator facet row with display metadata. */
export interface ViewFacetCreator {
    userId: string
    displayName: string
    email?: string
    count: number
}

/**
 * Catalog stats consumed by the Explorer stats bar.
 *
 * Returned by ``GET /api/v1/views/stats`` which accepts the same
 * filter params as the list endpoint — the numbers always describe
 * the currently-filtered population so the stats bar stays in sync
 * as users narrow their query.
 */
export interface ViewCatalogStats {
    total: number
    recentlyAdded: number
    needsAttention: number
    lastActivityAt: string | null
}

/**
 * Aggregate facets returned by ``GET /api/v1/views/facets``.
 *
 * Used by the Explorer to populate the Tag / View Type / Creator
 * dropdowns from the DB-wide set of values (not just the current page).
 * Facets are intentionally global so the dropdowns always show the
 * full option space — see ``getViewStats`` for filter-aware counts.
 */
export interface ViewFacetsResponse {
    tags: ViewFacetValue[]
    viewTypes: ViewFacetValue[]
    creators: ViewFacetCreator[]
}

// ============================================
// API Client
// ============================================

// Use authFetch so the JWT access token is attached to every view API
// call. Without this, the backend treats every request as anonymous,
// which breaks created_by attribution and per-user favourite flags.
const apiFetch = authFetch

// ============================================
// CRUD
// ============================================

/**
 * List views matching the given filters.
 *
 * Returns a paginated envelope with ``items`` + ``total`` + ``hasMore`` +
 * ``nextOffset``. Callers that don't need pagination metadata should
 * read ``.items`` directly rather than guessing from array length.
 *
 * Pass ``include: ['popular']`` to fold the trending strip into the
 * response (under ``popular``) so the Explorer page only makes one
 * round-trip instead of two.
 *
 * ``signal`` lets callers cancel in-flight requests on rapid filter
 * changes / unmount via a native ``AbortController`` — replaces the
 * legacy "set a cancelled flag and ignore the response" idiom.
 */
export async function listViews(
    params?: ViewListParams,
    signal?: AbortSignal,
): Promise<ViewListResponse> {
    const sp = new URLSearchParams()
    if (params?.visibilityIn && params.visibilityIn.length > 0) {
        params.visibilityIn.forEach(v => sp.append('visibilityIn', v))
    } else if (params?.visibility) {
        sp.set('visibility', params.visibility)
    }
    if (params?.workspaceIds && params.workspaceIds.length > 0) {
        params.workspaceIds.forEach(id => sp.append('workspaceIds', id))
    } else if (params?.workspaceId) {
        sp.set('workspaceId', params.workspaceId)
    }
    if (params?.contextModelId) sp.set('contextModelId', params.contextModelId)
    if (params?.dataSourceId) sp.set('dataSourceId', params.dataSourceId)
    if (params?.viewTypes && params.viewTypes.length > 0) {
        params.viewTypes.forEach(v => sp.append('viewTypes', v))
    } else if (params?.viewType) {
        sp.set('viewType', params.viewType)
    }
    if (params?.createdByIn && params.createdByIn.length > 0) {
        params.createdByIn.forEach(id => sp.append('createdByIn', id))
    } else if (params?.createdBy) {
        sp.set('createdBy', params.createdBy)
    }
    if (params?.createdAfter) sp.set('createdAfter', params.createdAfter)
    if (params?.search) sp.set('search', params.search)
    if (params?.tags) params.tags.forEach(t => sp.append('tags', t))
    if (params?.sort) sp.set('sort', params.sort)
    if (params?.limit != null) sp.set('limit', String(params.limit))
    if (params?.offset != null) sp.set('offset', String(params.offset))
    if (params?.favouritedOnly) sp.set('favouritedOnly', 'true')
    if (params?.includeDeleted) sp.set('includeDeleted', 'true')
    if (params?.deletedOnly) sp.set('deletedOnly', 'true')
    if (params?.attentionOnly) sp.set('attentionOnly', 'true')
    if (params?.category) sp.set('category', params.category)
    if (params?.include) params.include.forEach(v => sp.append('include', v))
    if (params?.popularLimit != null) sp.set('popularLimit', String(params.popularLimit))
    const qs = sp.toString()
    return apiFetch<ViewListResponse>(
        `/api/v1/views/${qs ? `?${qs}` : ''}`,
        signal ? { signal } : undefined,
    )
}

/** List the most-favourited enterprise-visible views */
export async function listPopularViews(limit = 20): Promise<View[]> {
    return apiFetch<View[]>(`/api/v1/views/popular?limit=${limit}`)
}

/**
 * Aggregate distinct tags, view types, and creators across non-deleted views.
 *
 * Used to populate Explorer filter dropdowns from the authoritative
 * DB-wide set rather than deriving from the currently-loaded page.
 */
export async function getViewFacets(): Promise<ViewFacetsResponse> {
    return apiFetch<ViewFacetsResponse>('/api/v1/views/facets')
}

/** Subset of ``ViewListParams`` that applies to the stats endpoint. */
export type ViewStatsParams = Omit<ViewListParams, 'limit' | 'offset' | 'contextModelId'>

/**
 * Fetch the Explorer stats-bar numbers for a given filter set.
 *
 * The endpoint accepts the same filter params as ``listViews`` so the
 * stats always describe the currently-filtered population.
 */
export async function getViewStats(params?: ViewStatsParams): Promise<ViewCatalogStats> {
    const sp = new URLSearchParams()
    if (params?.visibilityIn && params.visibilityIn.length > 0) {
        params.visibilityIn.forEach(v => sp.append('visibilityIn', v))
    } else if (params?.visibility) {
        sp.set('visibility', params.visibility)
    }
    if (params?.workspaceIds && params.workspaceIds.length > 0) {
        params.workspaceIds.forEach(id => sp.append('workspaceIds', id))
    } else if (params?.workspaceId) {
        sp.set('workspaceId', params.workspaceId)
    }
    if (params?.dataSourceId) sp.set('dataSourceId', params.dataSourceId)
    if (params?.viewTypes && params.viewTypes.length > 0) {
        params.viewTypes.forEach(v => sp.append('viewTypes', v))
    } else if (params?.viewType) {
        sp.set('viewType', params.viewType)
    }
    if (params?.createdByIn && params.createdByIn.length > 0) {
        params.createdByIn.forEach(id => sp.append('createdByIn', id))
    } else if (params?.createdBy) {
        sp.set('createdBy', params.createdBy)
    }
    if (params?.createdAfter) sp.set('createdAfter', params.createdAfter)
    if (params?.search) sp.set('search', params.search)
    if (params?.tags) params.tags.forEach(t => sp.append('tags', t))
    if (params?.favouritedOnly) sp.set('favouritedOnly', 'true')
    if (params?.includeDeleted) sp.set('includeDeleted', 'true')
    if (params?.deletedOnly) sp.set('deletedOnly', 'true')
    if (params?.attentionOnly) sp.set('attentionOnly', 'true')
    if (params?.category) sp.set('category', params.category)
    const qs = sp.toString()
    return apiFetch<ViewCatalogStats>(`/api/v1/views/stats${qs ? `?${qs}` : ''}`)
}

/** Create a new view (workspaceId required) */
export async function createView(data: ViewCreateRequest): Promise<View> {
    return apiFetch<View>('/api/v1/views/', {
        method: 'POST',
        body: JSON.stringify(data),
    })
}

/**
 * Get a single view by ID (enriched with workspace name + favourite data).
 *
 * `branchId` — when an open draft is reading, pass its active branch id so the
 * response projects that branch's layout overlay (base ⊕ overlay). Omit on
 * Published/main (or when no overlay exists) → base config, unchanged.
 */
export async function getView(
    viewId: string,
    branchId?: string,
    opts?: {
        /** Suppress the global AccessDeniedModal on 403 so the caller
         *  (ViewPage) can render its own access-error surface. */
        silent403?: boolean
    },
): Promise<View> {
    const qs = branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''
    return apiFetch<View>(
        `/api/v1/views/${viewId}${qs}`,
        opts?.silent403 ? { silent403: true } : undefined,
    )
}

export type ViewActivityAction =
    | 'created' | 'updated' | 'visibility_changed' | 'shared' | 'unshared'
    | 'favourited' | 'unfavourited' | 'deleted' | 'restored' | 'data_changed'

/** One entry in a view's activity timeline. Field diffs live in ``changes``
 *  (e.g. { name: { from, to }, viewType: { from, to }, content: true }). */
export interface ViewActivityEntry {
    id: string
    viewId: string
    action: ViewActivityAction
    actor: string | null
    actorName: string | null
    actorEmail: string | null
    summary: string | null
    changes: Record<string, unknown> | null
    createdAt: string
    /** Present only in the workspace-wide feed. */
    viewName?: string | null
    /** Which workspace the view lives in. View names are NOT unique — two views
     *  can both be called "Data Lineage" — so a feed that names one without
     *  saying where it lives is ambiguous. */
    workspaceId?: string | null
    /** True for a synthesized anchor on a legacy view with no recorded rows. */
    synthetic: boolean
}

/** A view's activity timeline, newest first. */
export async function getViewActivity(
    viewId: string,
    opts?: { action?: string; limit?: number },
): Promise<ViewActivityEntry[]> {
    const sp = new URLSearchParams()
    if (opts?.action) sp.set('action', opts.action)
    if (opts?.limit) sp.set('limit', String(opts.limit))
    const qs = sp.toString()
    return apiFetch<ViewActivityEntry[]>(`/api/v1/views/${viewId}/activity${qs ? `?${qs}` : ''}`)
}

/** Recent activity across every view the CURRENT USER can see — the dashboard's
 *  "What changed" feed. (Path is /me/feed, not /me/activity, which would bind
 *  the /{view_id}/activity route with view_id="me".) */
export async function getMyActivityFeed(limit = 15): Promise<ViewActivityEntry[]> {
    return apiFetch<ViewActivityEntry[]>(`/api/v1/views/me/feed?limit=${limit}`)
}

/** Recent activity across all of a workspace's views (each entry has viewName). */
export async function getWorkspaceViewActivity(
    workspaceId: string,
    opts?: { limit?: number },
): Promise<ViewActivityEntry[]> {
    const qs = opts?.limit ? `?limit=${opts.limit}` : ''
    return apiFetch<ViewActivityEntry[]>(`/api/v1/views/workspace/${workspaceId}/activity${qs}`)
}

/** Update an existing view */
export async function updateView(viewId: string, data: ViewUpdateRequest): Promise<View> {
    return apiFetch<View>(`/api/v1/views/${viewId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    })
}

/**
 * Update a view's layer layout (layers + assignments) in isolation — does
 * not touch name/content (other than entityScope)/filters/any other
 * config key. See backend `view_repo.update_view_layout`.
 *
 * `branchId` — when an open draft is editing, pass its active branch id so
 * the write lands on that branch's layout overlay instead of the published
 * view row (the backend routes on `?branchId`). Omit on Published/main so
 * the write updates the base config as before.
 */
export async function updateViewLayout(
    viewId: string,
    body: {
        referenceLayout: { layers: ViewLayerConfig[]; assignments: Record<string, LayerAssignmentEntry> }
        entityScope?: 'all' | 'curated'
        displayRules?: unknown[]
    },
    branchId?: string,
): Promise<View> {
    const qs = branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''
    return apiFetch<View>(`/api/v1/views/${viewId}/layout${qs}`, {
        method: 'PUT',
        body: JSON.stringify(body),
    })
}

/** Delete a view. Soft-deletes by default; pass permanent=true to remove from DB. */
export async function deleteView(viewId: string, permanent = false): Promise<void> {
    const qs = permanent ? '?permanent=true' : ''
    return apiFetch<void>(`/api/v1/views/${viewId}${qs}`, { method: 'DELETE' })
}

/** Restore a soft-deleted view */
export async function restoreView(viewId: string): Promise<View> {
    return apiFetch<View>(`/api/v1/views/${viewId}/restore`, { method: 'POST' })
}

/** Change the visibility of a view */
export async function updateViewVisibility(viewId: string, visibility: string): Promise<View> {
    return apiFetch<View>(`/api/v1/views/${viewId}/visibility`, {
        method: 'PUT',
        body: JSON.stringify({ visibility }),
    })
}

// ============================================
// Publication requests
// ============================================
//
// Publishing needs `workspace:view:publish`, which most members don't
// hold — so instead of a dead end, they ask and a holder answers. Every
// call except the withdraw returns the updated View, so callers can
// refresh straight from the response.

/** Ask for this view to be published to everyone. */
export async function requestViewPublication(viewId: string, note?: string): Promise<View> {
    return apiFetch<View>(`/api/v1/views/${viewId}/publish-request`, {
        method: 'POST',
        body: JSON.stringify({ note: note?.trim() || null }),
    })
}

/** Withdraw a pending request — the requester, or anyone who could answer it. */
export async function withdrawViewPublicationRequest(viewId: string): Promise<void> {
    return apiFetch<void>(`/api/v1/views/${viewId}/publish-request`, { method: 'DELETE' })
}

/** Approve a pending request: the view becomes enterprise-visible. */
export async function approveViewPublication(viewId: string): Promise<View> {
    return apiFetch<View>(`/api/v1/views/${viewId}/publish-request/approve`, { method: 'POST' })
}

/** Decline a pending request. The reason lands on the view's timeline. */
export async function denyViewPublication(viewId: string, reason?: string): Promise<View> {
    return apiFetch<View>(`/api/v1/views/${viewId}/publish-request/deny`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason?.trim() || null }),
    })
}

/** Favourite a view */
export async function favouriteView(viewId: string): Promise<void> {
    return apiFetch<void>(`/api/v1/views/${viewId}/favourite`, { method: 'POST' })
}

/** One entry in "Continue where you left off". Server-side + per-user.
 *  Optionals are `undefined` (not null) so consumers keep the exact shape the
 *  previous localStorage store exposed. */
export interface RecentViewEntry {
    viewId: string
    viewName: string
    viewType: string
    /** User-chosen view icon (config.icon) — wins over the type icon. */
    icon?: string
    workspaceId?: string
    workspaceName?: string
    dataSourceId?: string
    dataSourceName?: string
    visitedAt: string
}

/** Wire shape — the API sends JSON `null` for absent optionals. */
interface RecentViewApi extends Omit<RecentViewEntry, 'icon' | 'workspaceId' | 'workspaceName' | 'dataSourceId' | 'dataSourceName'> {
    icon?: string | null
    workspaceId?: string | null
    workspaceName?: string | null
    dataSourceId?: string | null
    dataSourceName?: string | null
}

/** The signed-in user's recently visited views — follows them across devices,
 *  and is joined against the live views (never a stale name / deleted entry). */
/** One piece of the caller's unfinished work — an open, unpublished draft. */
export interface MyDraftEntry {
    draftId: string
    graphId: string
    viewId: string
    viewName: string
    viewType?: string
    workspaceId?: string
    /** Drafts are usually unnamed; the view is the label that matters. */
    name?: string
    createdAt: string
    updatedAt: string
}

interface MyDraftApi extends Omit<MyDraftEntry, 'viewType' | 'workspaceId' | 'name'> {
    viewType?: string | null
    workspaceId?: string | null
    name?: string | null
}

export async function getMyDrafts(limit = 6): Promise<MyDraftEntry[]> {
    const raw = await apiFetch<MyDraftApi[]>(`/api/v1/views/me/drafts?limit=${limit}`)
    return (raw ?? []).map(d => ({
        ...d,
        viewType: d.viewType ?? undefined,
        workspaceId: d.workspaceId ?? undefined,
        name: d.name ?? undefined,
    }))
}

export async function getRecentViews(limit = 5): Promise<RecentViewEntry[]> {
    const raw = await apiFetch<RecentViewApi[]>(`/api/v1/views/me/recent?limit=${limit}`)
    // Normalise null → undefined at the boundary so consumers (sidebar, command
    // palette, dashboard) keep the shape they had under localStorage.
    return (raw ?? []).map(r => ({
        viewId: r.viewId,
        viewName: r.viewName,
        viewType: r.viewType,
        icon: r.icon ?? undefined,
        workspaceId: r.workspaceId ?? undefined,
        workspaceName: r.workspaceName ?? undefined,
        dataSourceId: r.dataSourceId ?? undefined,
        dataSourceName: r.dataSourceName ?? undefined,
        visitedAt: r.visitedAt,
    }))
}

/** Record that the current user opened this view (drives the recents strip). */
export async function recordViewVisit(viewId: string): Promise<void> {
    return apiFetch<void>(`/api/v1/views/${viewId}/visit`, { method: 'POST' })
}

/** Unfavourite a view */
export async function unfavouriteView(viewId: string): Promise<void> {
    return apiFetch<void>(`/api/v1/views/${viewId}/favourite`, { method: 'DELETE' })
}

// ============================================
// View → ViewConfiguration converter
// ============================================

/**
 * Convert a View API response to the ViewConfiguration type
 * consumed by CanvasRouter, ViewSelector, and SidebarNav.
 *
 * View.config stores the FULL ViewConfiguration shape — we just
 * overlay the top-level identity fields.
 */
export function viewToViewConfig(view: View): ViewConfiguration {
    const cfg = view.config ?? {}
    // Derive scopeKey from the authoritative workspaceId + dataSourceId on the API
    // response, matching the format used by setActiveScopeKey() in the schema store
    // (`${wsId}/${dsId}` or `${wsId}/default`). The stored cfg.scopeKey is unreliable
    // because it was a frontend-only field and is absent on server-created views.
    const scopeKey = view.workspaceId
        ? view.dataSourceId
            ? `${view.workspaceId}/${view.dataSourceId}`
            : `${view.workspaceId}/default`
        : cfg.scopeKey ?? null
    return {
        id: view.id,
        name: view.name,
        description: view.description,
        icon: cfg.icon ?? 'Layout',
        scopeKey,
        workspaceId: view.workspaceId,
        dataSourceId: view.dataSourceId ?? null,
        workspaceName: view.workspaceName,
        isFavourited: view.isFavourited,
        content: cfg.content ?? {
            visibleEntityTypes: [],
            visibleRelationshipTypes: [],
            defaultDepth: 5,
            maxDepth: 10,
            rootEntityTypes: ['domain'],
        },
        layout: cfg.layout ?? {
            type: (view.viewType ?? 'graph') as any,
            lod: { enabled: false, levels: [] },
        },
        filters: cfg.filters ?? {
            entityTypeFilters: [],
            fieldFilters: [],
            searchableFields: [],
            quickFilters: [],
        },
        entityOverrides: cfg.entityOverrides ?? {},
        grouping: cfg.grouping,
        isDefault: false,
        // The full tier — carried so the canvas can seed the Share dialog
        // without a re-fetch. `isPublic` survives as a deprecated
        // flattening for consumers not yet migrated.
        visibility: view.visibility,
        isPublic: view.visibility !== 'private',
        createdBy: view.createdBy ?? '',
        createdAt: view.createdAt,
        updatedAt: view.updatedAt,
    }
}
