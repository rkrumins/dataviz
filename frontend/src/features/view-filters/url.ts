/**
 * The view filters in the page address.
 *
 * The Explorer keeps every filter in its URL so a list can be bookmarked or sent to
 * a colleague, and that address is now also what a saved filter stores. Reading is
 * forgiving — an unknown value is dropped rather than failing the page — and
 * writing touches only filter keys, so `sort`, `layout` and anything else in the
 * address survive a filter change.
 */
import { isValidRule } from './dateFilter'
import {
  EMPTY_FILTERS, isContributorRole, isSourceKind, type ViewFilterState,
} from './model'

/** Every key this module owns. `creator` is the pre-People spelling, still read so
 *  old bookmarks keep working, and removed on the next write. */
const FILTER_KEYS = [
  'q', 'category', 'visibility', 'workspace', 'dataSource', 'type', 'tag',
  'contributor', 'contributorRole', 'creator', 'sourceKind', 'created', 'updated',
] as const

export function readFilterState(sp: URLSearchParams): ViewFilterState {
  const contributors = sp.getAll('contributor')
  const legacyCreators = contributors.length === 0 ? sp.getAll('creator') : []
  const role = sp.get('contributorRole')
  const sourceKind = sp.get('sourceKind')
  const created = sp.get('created')
  const updated = sp.get('updated')
  return {
    search: sp.get('q') ?? '',
    category: sp.get('category') || null,
    visibility: sp.get('visibility') || null,
    workspaceIds: sp.getAll('workspace'),
    dataSourceId: sp.get('dataSource') || null,
    viewTypes: sp.getAll('type'),
    tags: sp.getAll('tag'),
    contributorIds: legacyCreators.length > 0 ? legacyCreators : contributors,
    // A legacy `creator=` link meant "created by" — keep that meaning.
    contributorRole: legacyCreators.length > 0 ? 'created' : (isContributorRole(role) ? role : null),
    sourceKind: isSourceKind(sourceKind) ? sourceKind : null,
    created: isValidRule(created) ? created : null,
    updated: isValidRule(updated) ? updated : null,
  }
}

function setFilterKeys(sp: URLSearchParams, s: ViewFilterState): void {
  const one = (key: string, v: string | null) => { if (v) sp.set(key, v) }
  const many = (key: string, vs: string[]) => vs.forEach(v => sp.append(key, v))
  one('q', s.search.trim() || null)
  one('category', s.category)
  one('visibility', s.visibility)
  many('workspace', s.workspaceIds)
  one('dataSource', s.dataSourceId)
  many('type', s.viewTypes)
  many('tag', s.tags)
  many('contributor', s.contributorIds)
  // Kept even before anyone is picked: choosing "Edited" and then a person is the
  // natural order, and dropping the role in between would undo the first click.
  one('contributorRole', s.contributorRole)
  one('sourceKind', s.sourceKind)
  one('created', s.created)
  one('updated', s.updated)
}

/** `prev` with its filter keys replaced by `state`'s; every other key is kept. */
export function writeFilterState(prev: URLSearchParams, state: ViewFilterState): URLSearchParams {
  const next = new URLSearchParams(prev)
  FILTER_KEYS.forEach(k => next.delete(k))
  setFilterKeys(next, state)
  return next
}

/**
 * One spelling per filter set: keys and values sorted, empties dropped. Two lists
 * that show the same views have the same canonical query, which is how a saved
 * filter knows it is the one on screen. `sort` rides along when given, because a
 * saved filter restores the order too.
 */
/** Whether a stored query selects the same views as `state` — compared in
 *  canonical form, so how a link happened to spell it doesn't matter. */
export function matchesFilterQuery(query: string, state: ViewFilterState): boolean {
  return canonicalFilterQuery(readFilterState(new URLSearchParams(query))) === canonicalFilterQuery(state)
}

export function canonicalFilterQuery(state: ViewFilterState, extra: { sort?: string | null } = {}): string {
  const sp = new URLSearchParams()
  const full = { ...EMPTY_FILTERS, ...state }
  // A role with nobody picked filters nothing, so it doesn't make two lists differ.
  setFilterKeys(sp, full.contributorIds.length ? full : { ...full, contributorRole: null })
  if (extra.sort) sp.set('sort', extra.sort)
  const pairs = [...sp.entries()].sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv))
  return new URLSearchParams(pairs).toString()
}
