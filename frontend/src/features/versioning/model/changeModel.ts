/**
 * The unified change model — one normalized shape for "what changed", whatever the
 * source. The canvas diff overlay, the Changes panel, and the commit timeline all
 * consume a `ChangeSet`, so they render identically whether you're looking at:
 *   1. your uncommitted staged edits (the existing "Review & Save" flow),
 *   2. a draft's full delta vs main (the branch diff), or
 *   3. a single commit's delta.
 *
 * This is the deliberate unification of the formerly-separate staged-changes
 * highlighting and the branch diff: one tint vocabulary (added/removed/modified),
 * one panel, one overlay. Adapters in `changeAdapters.ts` produce a `ChangeSet`
 * from each of the three sources.
 */

export type ChangeStatus = 'added' | 'removed' | 'modified'
export type ChangeKind = 'node' | 'edge'

/** One field's before/after — powers the EntityDiff before/after table. */
export interface FieldDelta {
  field: string
  before: unknown
  after: unknown
}

/** Where a change came from — lets the panel show provenance + the right affordances. */
export type ChangeOrigin =
  | { source: 'staged'; stagedChangeId: string }
  | { source: 'branch'; branchId: string }
  | { source: 'commit'; commitId: string }
  | { source: 'pr'; prId: string }

export interface GraphChange {
  /** Stable id of the entity: node URN / entityId, or edge id. The canvas keys tints by this. */
  entityId: string
  kind: ChangeKind
  status: ChangeStatus
  /** Human label for the structured panel. */
  label: string
  /** Field-level deltas (present for `modified`; derivable for others). */
  fields?: FieldDelta[]
  /** Full snapshots for the before/after detail (added → before undefined; removed → after undefined). */
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  origin: ChangeOrigin
}

export interface ChangeCounts {
  added: number
  removed: number
  modified: number
}

export interface ChangeSet {
  changes: GraphChange[]
  /** O(1) lookup the canvas uses per node/edge to pick a tint / decide a ghost. */
  byEntityId: Map<string, GraphChange>
  counts: ChangeCounts
  origin: ChangeOrigin['source'] | 'mixed' | 'empty'
}

export const EMPTY_CHANGE_SET: ChangeSet = {
  changes: [],
  byEntityId: new Map(),
  counts: { added: 0, removed: 0, modified: 0 },
  origin: 'empty',
}

/** Assemble a `ChangeSet` from a flat list of changes (computes index + counts). */
export function buildChangeSet(changes: GraphChange[]): ChangeSet {
  const byEntityId = new Map<string, GraphChange>()
  const counts: ChangeCounts = { added: 0, removed: 0, modified: 0 }
  for (const c of changes) {
    // Last write wins for the canvas index — a node can only carry one tint.
    byEntityId.set(c.entityId, c)
    counts[c.status] += 1
  }
  const sources = new Set(changes.map((c) => c.origin.source))
  const origin: ChangeSet['origin'] =
    changes.length === 0 ? 'empty' : sources.size === 1 ? [...sources][0] : 'mixed'
  return { changes, byEntityId, counts, origin }
}

/** Shallow field-level diff between two payloads (skips equal + internal `_`-prefixed keys). */
export function deriveFieldDeltas(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): FieldDelta[] {
  const a = before ?? {}
  const b = after ?? {}
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const out: FieldDelta[] = []
  for (const field of keys) {
    if (field.startsWith('_')) continue
    const bv = (a as Record<string, unknown>)[field]
    const av = (b as Record<string, unknown>)[field]
    if (JSON.stringify(bv) !== JSON.stringify(av)) {
      out.push({ field, before: bv, after: av })
    }
  }
  return out.sort((x, y) => x.field.localeCompare(y.field))
}

/** Best-effort human label for an entity payload (node displayName / edge type). */
export function labelForPayload(
  entityId: string,
  payload: Record<string, unknown> | undefined,
  kind: ChangeKind,
): string {
  if (!payload) return entityId
  if (kind === 'edge') {
    const t = (payload.edgeType ?? payload.type) as string | undefined
    return t ? `${t}` : entityId
  }
  return (
    (payload.displayName as string) ||
    (payload.qualifiedName as string) ||
    (payload.urn as string) ||
    entityId
  )
}
