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
 * - `phase` guards the one dangerous window: a crash AFTER a save's server
 *   commit returns but BEFORE the store clears would otherwise re-apply
 *   already-committed changes (duplicating graph data). While a save is in
 *   flight the snapshot is marked 'committing'; on restore a 'committing'
 *   snapshot is discarded, not replayed — we prefer losing that millisecond
 *   window of work over duplicating it.
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
  /** 'staged' = safe to restore; 'committing' = a save was in flight, discard. */
  phase: 'staged' | 'committing'
  savedAt: number
  changes: SerializableChange[]
  pendingNodes: LineageNode[]
  pendingEdges: LineageEdge[]
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

/** Flip an existing snapshot to 'committing' (called when a save starts) so a
 *  crash mid-commit doesn't restore already-committed work. No-op if absent. */
export function markSnapshotCommitting(scopeKey: string): void {
  const snap = readSnapshot(scopeKey)
  if (!snap) return
  writeSnapshot({ ...snap, phase: 'committing' })
}

/**
 * Decide what to do with a snapshot on canvas mount. PURE so it can be
 * unit-tested without the DOM/stores.
 *   - null            → nothing persisted, no-op.
 *   - 'discard'       → stale/unsafe (wrong branch, mid-commit, or empty) —
 *                       delete it, don't restore.
 *   - 'restore'       → safe to replay onto the canvas.
 */
export function reconcileSnapshot(
  snapshot: StagedDraftSnapshot | null,
  currentBranchId: string | null,
): 'noop' | 'discard' | 'restore' {
  if (!snapshot) return 'noop'
  if (snapshot.phase === 'committing') return 'discard'
  if (snapshot.branchId !== currentBranchId) return 'discard'
  if (snapshot.changes.length === 0) return 'discard'
  return 'restore'
}
