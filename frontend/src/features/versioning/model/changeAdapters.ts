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
  type ChangeKind,
  type ChangeOrigin,
  type ChangeSet,
  type ChangeStatus,
  type GraphChange,
} from './changeModel'
import { stagedChangeColor, type StagedChange } from '@/store/stagedChangesStore'
import type { DiffEntry, DiffVsMainResponse } from '@/services/versioningApiService'

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

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
  const mk = (e: DiffEntry, status: ChangeStatus): GraphChange => {
    const before = asRecord(e.before)
    const after = asRecord(e.after)
    return {
      entityId: e.entityId,
      kind: e.kind,
      status,
      label: labelForPayload(e.entityId, after ?? before, e.kind),
      fields: status === 'modified' ? deriveFieldDeltas(before, after) : undefined,
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

/** What a pull brought in from Published — attributed to the `pull` commit that recorded it, so it
 *  renders in the same visual language as every other diff (emerald added / amber modified / rose
 *  removed, per useDiffDecoration). */
export function fromIncomingDiff(resp: DiffVsMainResponse, pullCommitId: string): ChangeSet {
  return fromDiffEntries(resp.added, resp.removed, resp.modified, { source: 'commit', commitId: pullCommitId })
}
