/**
 * reviewIndex — Review & Save's staged changes, indexed once for a list that may hold 50,000 of
 * them: the groups (`buildReviewGroups`), which group each change is in, and the counts the filter
 * bar shows (by status, by kind, by type). Built once per list of changes and shared by every
 * reader; filtering walks it without building anything per row (a row's search text is made the
 * first time a search reads it).
 *
 * Pure: names come from the caller, as for `buildReviewGroups`.
 */
import type { StagedChange } from '@/store/stagedChangesStore'
import type { ChangeStatus } from './changeModel'
import { buildReviewGroups, type NameLookup, type ReviewGroup, type ReviewKind } from './reviewModel'

export interface ReviewFacets {
  status: Record<ChangeStatus, number>
  kind: Record<ReviewKind, number>
  /** Entity types, most changed first ('' — untyped). */
  types: { type: string; n: number }[]
}

export interface ReviewIndex {
  groups: ReviewGroup[]
  /** A change's id → the index of its group. */
  groupOf: Map<string, number>
  facets: ReviewFacets
}

export interface ReviewFilter {
  /** None chosen — every status. */
  statuses: ChangeStatus[]
  kind: ReviewKind | 'all'
  /** An entity type; '' — any. */
  type: string
  q: string
  /** Only what needs attention: a change the save refused, or one in conflict. */
  attention: boolean
}

export const NO_FILTER: ReviewFilter = { statuses: [], kind: 'all', type: '', q: '', attention: false }

const cache = new WeakMap<readonly StagedChange[], ReviewIndex>()

/** The index for these changes — built once per list (the store replaces the list on every edit). */
export function buildReviewIndex(changes: readonly StagedChange[], lookup: NameLookup): ReviewIndex {
  const hit = cache.get(changes)
  if (hit) return hit
  const groups = buildReviewGroups(changes, lookup)
  const groupOf = new Map<string, number>()
  const status: Record<ChangeStatus, number> = { added: 0, modified: 0, removed: 0 }
  const kind: Record<ReviewKind, number> = { node: 0, edge: 0, layout: 0 }
  const types = new Map<string, number>()
  groups.forEach((g, i) => {
    for (const c of g.changes) groupOf.set(c.id, i)
    kind[g.kind]++
    if (g.kind === 'layout') return
    status[g.status]++
    if (g.kind === 'node') types.set(g.typeId ?? '', (types.get(g.typeId ?? '') ?? 0) + 1)
  })
  const index: ReviewIndex = {
    groups,
    groupOf,
    facets: { status, kind, types: [...types].map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n) },
  }
  cache.set(changes, index)
  return index
}

/** A group needs attention: the last save refused one of its changes, or one is in conflict. */
export function needsAttention(g: ReviewGroup, problemIds?: ReadonlySet<string>): boolean {
  return g.changes.some((c) => !!c.error || !!c.conflict || !!problemIds?.has(c.id))
}

const searchText = new WeakMap<ReviewGroup, string>()
function textOf(g: ReviewGroup): string {
  let t = searchText.get(g)
  if (t === undefined) {
    t = [g.name, g.key, g.typeId ?? '', ...g.changes.map((c) => `${c.summary} ${c.targetUrn ?? ''}`)].join('\n').toLowerCase()
    searchText.set(g, t)
  }
  return t
}

/** The groups the filter keeps, as indices into `index.groups`, in their order. */
export function filterRows(index: ReviewIndex, f: ReviewFilter, problemIds?: ReadonlySet<string>): number[] {
  const q = f.q.trim().toLowerCase()
  const statuses = f.statuses.length ? new Set(f.statuses) : null
  const out: number[] = []
  const { groups } = index
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    if (f.kind !== 'all' && g.kind !== f.kind) continue
    if (statuses && (g.kind === 'layout' || !statuses.has(g.status))) continue
    if (f.type && (g.kind !== 'node' || (g.typeId ?? '') !== f.type)) continue
    if (f.attention && !needsAttention(g, problemIds)) continue
    if (q && !textOf(g).includes(q)) continue
    out.push(i)
  }
  return out
}

/** A row's stable key: groups of different kinds may share a target id. */
export const rowKey = (g: ReviewGroup) => `${g.kind}:${g.key}`

/** The filter narrows what is shown. */
export const isNarrowed = (f: ReviewFilter) => f.statuses.length > 0 || f.kind !== 'all' || !!f.type || !!f.q.trim() || f.attention
