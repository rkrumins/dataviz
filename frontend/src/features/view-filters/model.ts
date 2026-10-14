/**
 * The view filters as one value — what the Explorer keeps in its address and the
 * workspace Views tab keeps in state.
 *
 * Both surfaces render the same controlled components over this shape, so a filter
 * added here reaches both, and the two cannot drift into filtering differently. It
 * holds what the person CHOSE (a date rule such as `7d`, the token `me`), never the
 * resolved timestamps or ids: those depend on the day and on who is signed in, and
 * are worked out at the edge by `resolveFilters` (params.ts).
 */

/** Which of a person's roles on a view the People filter matches. `null` is the
 *  default: they created it or last edited it. Publishing data is opt-in because a
 *  publish stamps every view on the source, including views the person never opened. */
export type ContributorRole = 'created' | 'edited' | 'published'

/** Whether the graph behind a view is versioned (edited here through drafts, review
 *  and publish) or external (mastered by another system, read-only here). */
export type SourceKind = 'versioned' | 'external'

/** Which timestamp a date rule applies to. `updated` is the view's last change of
 *  any kind — settings, layout or data. */
export type DateField = 'created' | 'updated'

/** Stands for the signed-in person in `contributorIds`, so a bookmarked or saved
 *  filter keeps meaning "me" for whoever opens it. */
export const ME = 'me'

export interface ViewFilterState {
  /** Committed search text (the Explorer debounces typing into it). */
  search: string
  /** 'my-views' | 'my-favourites' | 'recently-added' | 'shared-with-me' | 'needs-attention' | 'deleted' | null */
  category: string | null
  visibility: string | null
  workspaceIds: string[]
  dataSourceId: string | null
  viewTypes: string[]
  tags: string[]
  /** User ids, and possibly `ME`. */
  contributorIds: string[]
  contributorRole: ContributorRole | null
  sourceKind: SourceKind | null
  /** Date rules (see dateFilter.ts), independent of each other. */
  created: string | null
  updated: string | null
}

export const EMPTY_FILTERS: ViewFilterState = {
  search: '',
  category: null,
  visibility: null,
  workspaceIds: [],
  dataSourceId: null,
  viewTypes: [],
  tags: [],
  contributorIds: [],
  contributorRole: null,
  sourceKind: null,
  created: null,
  updated: null,
}

export const CONTRIBUTOR_ROLES: readonly ContributorRole[] = ['created', 'edited', 'published']
export const SOURCE_KINDS: readonly SourceKind[] = ['versioned', 'external']

export function isContributorRole(v: unknown): v is ContributorRole {
  return typeof v === 'string' && (CONTRIBUTOR_ROLES as readonly string[]).includes(v)
}

export function isSourceKind(v: unknown): v is SourceKind {
  return typeof v === 'string' && (SOURCE_KINDS as readonly string[]).includes(v)
}

/** Anything narrowing the list. `ignore` drops dimensions a surface fixes for itself
 *  (the workspace tab is always scoped to its own workspace). */
export function isAnyFilterActive(
  s: ViewFilterState,
  ignore: { workspace?: boolean } = {},
): boolean {
  return Boolean(
    s.search.trim() || s.category || s.visibility
    || (!ignore.workspace && s.workspaceIds.length)
    || s.dataSourceId || s.viewTypes.length || s.tags.length
    || s.contributorIds.length || s.sourceKind || s.created || s.updated,
  )
}
