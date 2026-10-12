/**
 * From what a person chose to what the API is asked.
 *
 * `resolveFilters` turns a `ViewFilterState` into concrete values — `me` into the
 * signed-in user's id, a date rule into instants, a workspace tab's scope into a
 * workspace id — and `toQueryParams` turns those into the query every view endpoint
 * takes. The list, the stats bar, the facet counts and every count in between go
 * through these two functions, so they cannot disagree about which views a filter
 * selects.
 */
import type { ViewFilterParams } from '@/services/viewApiService'
import { ruleBounds } from './dateFilter'
import { ME, type ContributorRole, type SourceKind, type ViewFilterState } from './model'

/** The filter half of a list request — no paging, sort or embeds. */
export type ViewQueryParams = ViewFilterParams

/** A filter set with every relative choice pinned down. */
export interface ResolvedViewFilters {
  search: string
  visibility: string | null
  workspaceIds: string[]
  dataSourceId: string | null
  viewTypes: string[]
  tags: string[]
  contributorIds: string[]
  contributorRole: ContributorRole | null
  sourceKind: SourceKind | null
  createdAfter: string | null
  createdBefore: string | null
  updatedAfter: string | null
  updatedBefore: string | null
  category: string | null
  currentUserId: string | null
}

export interface ResolveContext {
  currentUserId: string | null
  /** Local `YYYY-MM-DD` the date rules resolve against (see `useLocalDay`). */
  today: string
  /** A surface fixed to one workspace (the workspace Views tab). */
  scopeWorkspaceId?: string | null
}

/** Stands in for a user id when nobody is signed in, so "me" matches nothing
 *  rather than silently matching everyone — the label must stay true. */
const NO_USER = '__no_user__'

export function resolveFilters(state: ViewFilterState, ctx: ResolveContext): ResolvedViewFilters {
  const created = state.created ? ruleBounds(state.created, ctx.today) : null
  const updated = state.updated ? ruleBounds(state.updated, ctx.today) : null
  const me = ctx.currentUserId ?? NO_USER
  return {
    search: state.search,
    visibility: state.visibility,
    workspaceIds: ctx.scopeWorkspaceId ? [ctx.scopeWorkspaceId] : state.workspaceIds,
    dataSourceId: state.dataSourceId,
    viewTypes: state.viewTypes,
    tags: state.tags,
    contributorIds: [...new Set(state.contributorIds.map(id => (id === ME ? me : id)))],
    contributorRole: state.contributorRole,
    sourceKind: state.sourceKind,
    createdAfter: created?.after ?? null,
    createdBefore: created?.before ?? null,
    updatedAfter: updated?.after ?? null,
    updatedBefore: updated?.before ?? null,
    category: state.category,
    currentUserId: ctx.currentUserId,
  }
}

/**
 * Translate a user-selected category to the concrete API params the backend
 * understands. Centralising this here keeps the client/server contract explicit —
 * no hidden client-side filtering.
 */
export function resolveCategoryParams(
  category: string | null,
  currentUserId: string | null,
): Partial<ViewQueryParams> {
  switch (category) {
    case 'my-views':
      // If we have no user id the Explorer page falls back to showing
      // nothing (not "all") so the filter label stays truthful.
      return currentUserId ? { createdBy: currentUserId } : { createdBy: NO_USER }
    case 'my-favourites':
      return { favouritedOnly: true }
    case 'recently-added': {
      // IMPORTANT: quantise the cutoff to a 5-minute bucket so the
      // string value is stable across re-renders. Without this, every
      // render produces a fresh ``Date.now()`` → fresh ISO string →
      // fresh React Query key → refetch → state update → re-render →
      // infinite fetch loop. The 5-minute window means the "last 7
      // days" cutoff can drift by at most 5 minutes, which is fine
      // for a human-facing "recent" filter.
      const QUANTUM_MS = 5 * 60 * 1000
      const now = Math.floor(Date.now() / QUANTUM_MS) * QUANTUM_MS
      const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000)
      return { createdAfter: sevenDaysAgo.toISOString() }
    }
    case 'shared-with-me':
      // Server-side truth: views reachable through an explicit grant
      // (direct or via group), excluding your own. The old visibilityIn
      // approximation showed every workspace/enterprise view instead.
      return { category: 'shared-with-me' }
    case 'needs-attention':
      return { attentionOnly: true }
    case 'deleted':
      return { deletedOnly: true }
    default:
      return {}
  }
}

/** The later of two lower bounds — both are `toISOString()` output, so they compare
 *  as strings. */
function laterOf(a: string | null | undefined, b: string | null | undefined): string | undefined {
  if (!a) return b ?? undefined
  if (!b) return a
  return a > b ? a : b
}

export function toQueryParams(
  r: ResolvedViewFilters & { favouritedOnly?: boolean },
): ViewQueryParams {
  const categoryParams = resolveCategoryParams(r.category, r.currentUserId)
  return {
    search: r.search || undefined,
    visibility: r.visibility || undefined,
    favouritedOnly: r.favouritedOnly || undefined,
    dataSourceId: r.dataSourceId || undefined,
    workspaceIds: r.workspaceIds.length > 0 ? r.workspaceIds : undefined,
    viewTypes: r.viewTypes.length > 0 ? r.viewTypes : undefined,
    tags: r.tags.length > 0 ? r.tags : undefined,
    contributorIn: r.contributorIds.length > 0 ? r.contributorIds : undefined,
    contributorRole: r.contributorIds.length > 0 && r.contributorRole ? r.contributorRole : undefined,
    sourceKind: r.sourceKind ?? undefined,
    createdBefore: r.createdBefore ?? undefined,
    updatedAfter: r.updatedAfter ?? undefined,
    updatedBefore: r.updatedBefore ?? undefined,
    // Category params last so they can override defaults (the `deleted`
    // category sets `deletedOnly`) — except the created lower bound, which is
    // merged: "Recent" and a created date rule must INTERSECT. Spread last
    // alone, Recent's 7-day cutoff silently replaced the person's own date.
    ...categoryParams,
    createdAfter: laterOf(r.createdAfter, categoryParams.createdAfter),
  }
}
