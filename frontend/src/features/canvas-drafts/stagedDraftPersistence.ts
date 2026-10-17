/**
 * Staged-draft persistence — survives a refresh with the user's unsaved
 * Context View work (staged entities/edges + the review op-log), which
 * otherwise lives only in memory (useStagedChangesStore + the optimistic
 * useCanvasStore nodes) and is wiped by any reload.
 *
 * Design (see the store for context):
 * - We snapshot ONLY the serializable data of each StagedChange — the
 *   `apply`/`discard`/`reapply` closures cannot be JSON'd. The draft save
 *   path (saveStagedChangesToDraft) reads data, not closures, so restored
 *   changes still save; a generic `discard` is rebuilt on restore so
 *   per-item discard still removes the optimistic canvas node.
 * - We also snapshot the optimistic canvas nodes/edges (isPending) so the
 *   exact visual state — including layout positions — comes back verbatim
 *   rather than being re-derived.
 * - Keyed by the same scope string the store already partitions by
 *   (`${ws}::${ds}::${branch}`), extended with viewId for branch-per-view.
 * - `phase` marks the one dangerous window: a crash while a save is in
 *   flight, when the server may or may not have committed it. The snapshot is
 *   then 'committing' and carries the save's Idempotency-Key (`pendingSave`);
 *   on restore the work comes back and saving the same batch again reuses that
 *   key, so the server answers with what the first save did instead of
 *   applying it twice — and applies it if the first save was refused.
 */
import type { LineageNode, LineageEdge } from '@/store/canvas'
import type { StagedChange } from '@/store/stagedChangesStore'

const KEY_PREFIX = 'synodic:staged-draft:'
/** Bump when the snapshot shape changes so stale-shaped snapshots are ignored. */
const SNAPSHOT_VERSION = 1

/** The serializable fields of a StagedChange (closures dropped). */
export type SerializableChange = Pick<
  StagedChange,
  'id' | 'type' | 'targetId' | 'targetUrn' | 'before' | 'after' | 'summary' | 'timestamp'
>

export interface StagedDraftSnapshot {
  version: number
  scopeKey: string
  /** Resolved branch this work belongs to — restore refuses a mismatch. */
  branchId: string | null
  /** 'staged' = no save in flight; 'committing' = a save was in flight (see `pendingSave`). */
  phase: 'staged' | 'committing'
  /** The save that may have reached the server — its retry reuses the key (saveStagedChangesToDraft). */
  pendingSave?: { body: string; key: string }
  savedAt: number
  changes: SerializableChange[]
  /** The canvas copies of every node / edge the unsaved work touches — new ones AND existing ones
   *  it edited (a rename carries no pending marker). */
  pendingNodes: LineageNode[]
  pendingEdges: LineageEdge[]
  /** Layer pins of unsaved top-level entities (urn → layer id). The view layout's own copy may not
   *  have reached the server before the refresh; without it a restored entity belonged to no
   *  column and was invisible. Absent in snapshots written before it existed. */
  pins?: Record<string, string>
}

function storageKey(scopeKey: string): string {
  return `${KEY_PREFIX}${scopeKey}`
}

/** Strip the non-serializable closures from a live StagedChange. */
export function toSerializableChange(c: StagedChange): SerializableChange {
  return {
    id: c.id,
    type: c.type,
    targetId: c.targetId,
    targetUrn: c.targetUrn,
    before: c.before,
    after: c.after,
    summary: c.summary,
    timestamp: c.timestamp,
  }
}

export function writeSnapshot(snapshot: StagedDraftSnapshot): void {
  try {
    localStorage.setItem(storageKey(snapshot.scopeKey), JSON.stringify(snapshot))
  } catch {
    // Quota exceeded / private mode — persistence is best-effort; the app
    // still works, refresh just loses the unsaved work as it did before.
  }
}

export function readSnapshot(scopeKey: string): StagedDraftSnapshot | null {
  try {
    const raw = localStorage.getItem(storageKey(scopeKey))
    if (!raw) return null
    const parsed = JSON.parse(raw) as StagedDraftSnapshot
    if (parsed?.version !== SNAPSHOT_VERSION) return null
    if (!Array.isArray(parsed.changes) || parsed.changes.length === 0) return null
    return parsed
  } catch {
    return null
  }
}

export function clearSnapshot(scopeKey: string): void {
  try {
    localStorage.removeItem(storageKey(scopeKey))
  } catch {
    // ignore
  }
}

/** Flip an existing snapshot to 'committing' (called when a save starts, and again with the save's
 *  key before it is sent) so a crash mid-commit restores work that retries under that key. No-op if
 *  absent. */
export function markSnapshotCommitting(scopeKey: string, pendingSave?: { body: string; key: string }): void {
  const snap = readSnapshot(scopeKey)
  if (!snap) return
  writeSnapshot({ ...snap, phase: 'committing', ...(pendingSave && { pendingSave }) })
}

/**
 * Decide what to do with a snapshot on canvas mount. PURE so it can be
 * unit-tested without the DOM/stores.
 *   - null            → nothing persisted, no-op.
 *   - 'discard'       → stale/unsafe (wrong branch or empty) —
 *                       delete it, don't restore.
 *   - 'restore'       → safe to replay onto the canvas.
 */
export function reconcileSnapshot(
  snapshot: StagedDraftSnapshot | null,
  currentBranchId: string | null,
): 'noop' | 'discard' | 'restore' {
  if (!snapshot) return 'noop'
  if (snapshot.branchId !== currentBranchId) return 'discard'
  if (snapshot.changes.length === 0) return 'discard'
  return 'restore'
}
