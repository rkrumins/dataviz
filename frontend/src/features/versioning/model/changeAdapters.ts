/**
 * Adapters: each of the three change sources → one `ChangeSet`.
 *
 * This is the bridge that makes "your uncommitted edits" speak the same visual
 * language as "this PR's changes": `fromStagedChanges` maps the existing
 * `stagedChangesStore`, `fromDiffVsMain` maps the backend's UI-shaped branch diff,
 * and `fromDiffEntries` is the shared core (also reused for single-commit diffs).
 */
import {
  buildChangeSet,
  deriveFieldDeltas,
  labelForPayload,
  type ChangeCounts,
  type ChangeKind,
  type ChangeOrigin,
  type ChangeSet,
  type ChangeStatus,
  type GraphChange,
} from './changeModel'
import { stagedChangeColor, type StagedChange } from '@/store/stagedChangesStore'
import type { ChangeListIndex, DiffEntry, DiffVsMainResponse } from '@/services/versioningApiService'

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** green → added, red → removed, amber → modified (the existing tint convention). */
function statusFromStaged(change: StagedChange): ChangeStatus {
  switch (stagedChangeColor(change.type)) {
    case 'green':
      return 'added'
    case 'red':
      return 'removed'
    default:
      return 'modified'
  }
}

/** Uncommitted staged edits → ChangeSet (each change keeps its id for per-row discard). */
export function fromStagedChanges(changes: StagedChange[]): ChangeSet {
  const out: GraphChange[] = changes.map((c) => {
    const kind: ChangeKind = c.type.includes('edge') ? 'edge' : 'node'
    const status = statusFromStaged(c)
    const before = asRecord(c.before)
    const after = asRecord(c.after)
    return {
      entityId: c.targetUrn ?? c.targetId,
      kind,
      status,
      label: c.summary || labelForPayload(c.targetUrn ?? c.targetId, after ?? before, kind),
      fields: status === 'modified' ? deriveFieldDeltas(before, after) : undefined,
      before,
      after,
      origin: { source: 'staged', stagedChangeId: c.id },
    }
  })
  return buildChangeSet(out)
}

/** Shared core: classified DiffEntry lists → ChangeSet under a given origin. */
export function fromDiffEntries(
  added: DiffEntry[],
  removed: DiffEntry[],
  modified: DiffEntry[],
  origin: ChangeOrigin,
): ChangeSet {
  // Field deltas are left to the row that is opened (EntityDiff): computed here for every
  // modified entity, a 100,000-change diff spent seconds in JSON before the list could draw.
  const mk = (e: DiffEntry, status: ChangeStatus): GraphChange => {
    const before = asRecord(e.before)
    const after = asRecord(e.after)
    const payload = after ?? before
    // The canvas names a node by its urn and an edge's ends by urn; an entity id need not be one
    // (an import's is not). A node without a urn reads as the reader's stand-in, `gv:<entity id>`.
    const names = e.kind === 'node'
      ? { urn: e.urn ?? str(payload?.urn) ?? `gv:${e.entityId}` }
      : { sourceUrn: e.sourceUrn ?? str(payload?.sourceEntityId), targetUrn: e.targetUrn ?? str(payload?.targetEntityId) }
    return {
      entityId: e.entityId,
      ...names,
      kind: e.kind,
      status,
      label: labelForPayload(e.entityId, after ?? before, e.kind),
      before,
      after,
      origin,
    }
  }
  return buildChangeSet([
    ...added.map((e) => mk(e, 'added')),
    ...modified.map((e) => mk(e, 'modified')),
    ...removed.map((e) => mk(e, 'removed')),
  ])
}

/** A draft's full delta vs its base (the branch diff overlay). */
export function fromDiffVsMain(resp: DiffVsMainResponse, branchId: string): ChangeSet {
  return fromDiffEntries(resp.added, resp.removed, resp.modified, { source: 'branch', branchId })
}

/** A PR's itemised "Files Changed" (the review center's diff). */
export function fromPrDiff(resp: DiffVsMainResponse, prId: string): ChangeSet {
  return fromDiffEntries(resp.added, resp.removed, resp.modified, { source: 'pr', prId })
}

const INDEX_STATUS = { a: 'added', m: 'modified', r: 'removed' } as const

/** A draft's compact change index (`/diff/index`) → the ChangeSet the canvas marks entities by, for a
 *  draft too large for the whole diff. No payloads: a node carries its id and status, an edge its
 *  type and ends — what finds a draft's created children and draws a removed link — so nothing here
 *  can reconstruct a removed node (no ghost). `counts` stands in for the entries of an index too
 *  large to list (`truncated`). */
export function fromChangeIndex(index: ChangeListIndex, branchId: string, counts?: ChangeCounts): ChangeSet {
  const origin: ChangeOrigin = { source: 'branch', branchId }
  const changes: GraphChange[] = index.entries.map((e) => {
    const status = INDEX_STATUS[e[2]]
    if (e[1] === 'n') return { entityId: e[0], kind: 'node', status, label: e[0], origin }
    const ends = { edgeType: e[3], sourceEntityId: e[4], targetEntityId: e[5] }
    return {
      entityId: e[0], kind: 'edge', status, label: e[3] ?? e[0], origin,
      ...(status === 'removed' ? { before: ends } : { after: ends }),
    }
  })
  const set = buildChangeSet(changes)
  return counts && index.truncated ? { ...set, counts } : set
}

/** Counts alone, for a surface that says how much a draft changes and lists none of it. */
export function fromChangeCounts(counts: ChangeCounts, branchId: string): ChangeSet {
  const any = counts.added + counts.modified + counts.removed > 0
  return { changes: [], byEntityId: new Map(), counts, origin: any ? 'branch' : 'empty' }
}
