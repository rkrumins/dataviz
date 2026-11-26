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
 *   on restore the work comes back and the next save first sends that batch
 *   again, exactly, under that key, so the server answers with what the first
 *   save did instead of applying it twice — and applies it if it never arrived.
 *   Edits made since go after it, under a key of their own.
 * - Where it is kept: a snapshot of up to {@link LARGE_SNAPSHOT} changes in localStorage, as it
 *   always was; a larger one in IndexedDB (localStorage holds ~5 MB), with a small marker left in
 *   localStorage that says so and carries the phase and the save key — so a crash mid-save is
 *   caught however large the work, and the marker is written synchronously.
 */
import type { LineageNode, LineageEdge } from '@/store/canvas'
import type { StagedChange } from '@/store/stagedChangesStore'
import { idbAvailable, idbDelete, idbGet, idbSet } from '@/lib/idbStore'

const KEY_PREFIX = 'synodic:staged-draft:'
/** Bump when the snapshot shape changes so stale-shaped snapshots are ignored. */
const SNAPSHOT_VERSION = 1

/** The serializable fields of a StagedChange (closures dropped). */
/** A save that may have reached the server: its request body, its Idempotency-Key, and the staged
 *  changes it carried — each one's id → its `after` as sent (JSON), so an edit made since is told
 *  apart. Absent in snapshots written before it existed: such a save is only ever resent as is. */
export interface PendingSave {
  body: string
  key: string
  sent?: Record<string, string>
}

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
  pendingSave?: PendingSave
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
  /** Columns mapped to an unsaved entity (layer id → its temp urn), for the same reason: restored
   *  without them, the column would stand empty and the entity show as a row. Absent in snapshots
   *  written before it existed. */
  anchors?: Record<string, string>
}

/** Past this many changes a snapshot is kept in IndexedDB. */
export const LARGE_SNAPSHOT = 2000

/** What localStorage holds for a snapshot kept in IndexedDB. */
interface SnapshotMarker {
  version: number
  scopeKey: string
  where: 'idb'
  branchId: string | null
  phase: StagedDraftSnapshot['phase']
  savedAt: number
  count: number
  /** A save in flight: its key (the save itself is kept in IndexedDB, it may be large). */
  pendingKey?: string
}

function storageKey(scopeKey: string): string {
  return `${KEY_PREFIX}${scopeKey}`
}
const bodyKey = (scopeKey: string) => `snapshot:${scopeKey}`
const pendingKey = (scopeKey: string) => `pending:${scopeKey}`

function readStored(scopeKey: string): StagedDraftSnapshot | SnapshotMarker | null {
  try {
    const raw = localStorage.getItem(storageKey(scopeKey))
    if (!raw) return null
    const parsed = JSON.parse(raw) as StagedDraftSnapshot | SnapshotMarker
    return parsed?.version === SNAPSHOT_VERSION ? parsed : null
  } catch {
    return null
  }
}
const isMarker = (v: StagedDraftSnapshot | SnapshotMarker | null): v is SnapshotMarker => (v as SnapshotMarker | null)?.where === 'idb'

function writeLocal(scopeKey: string, value: StagedDraftSnapshot | SnapshotMarker): boolean {
  try {
    localStorage.setItem(storageKey(scopeKey), JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

/** Keep `snapshot` where it fits: `kept` says at once whether it is being kept, `durable` when it is. */
function persist(snapshot: StagedDraftSnapshot): { kept: boolean; durable: Promise<boolean> } {
  const scopeKey = snapshot.scopeKey
  if (snapshot.changes.length <= LARGE_SNAPSHOT && writeLocal(scopeKey, snapshot)) {
    void idbDelete(bodyKey(scopeKey))
    return { kept: true, durable: Promise.resolve(true) }
  }
  const marker: SnapshotMarker = {
    version: SNAPSHOT_VERSION, scopeKey, where: 'idb', branchId: snapshot.branchId, phase: snapshot.phase,
    savedAt: snapshot.savedAt, count: snapshot.changes.length, pendingKey: snapshot.pendingSave?.key,
  }
  if (!idbAvailable() || !writeLocal(scopeKey, marker)) {
    clearSnapshot(scopeKey)
    return { kept: false, durable: Promise.resolve(false) }
  }
  const durable = idbSet(bodyKey(scopeKey), snapshot).then((ok) => {
    if (!ok) clearSnapshot(scopeKey)
    return ok
  })
  return { kept: true, durable }
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

/** Keep the snapshot — starting at once; a large one finishes in IndexedDB a moment later (see
 *  `writeSnapshotAsync` to wait for it). False when it cannot be kept (too large for the browser's
 *  storage, or private mode): the one there before is removed too, so a reload never brings back an
 *  older, partial set of the work as if it were all of it. */
export function writeSnapshot(snapshot: StagedDraftSnapshot): boolean {
  return persist(snapshot).kept
}

/** `writeSnapshot`, resolved once the snapshot is durable — or with false when it could not be kept. */
export function writeSnapshotAsync(snapshot: StagedDraftSnapshot): Promise<boolean> {
  return persist(snapshot).durable
}

/** A snapshot kept in localStorage. One kept in IndexedDB (past {@link LARGE_SNAPSHOT} changes)
 *  reads only with `readSnapshotAsync`. */
export function readSnapshot(scopeKey: string): StagedDraftSnapshot | null {
  const stored = readStored(scopeKey)
  if (!stored || isMarker(stored)) return null
  return Array.isArray(stored.changes) && stored.changes.length > 0 ? stored : null
}

/** The snapshot, wherever it is kept — with the phase and the save in flight as last marked. */
export async function readSnapshotAsync(scopeKey: string): Promise<StagedDraftSnapshot | null> {
  const stored = readStored(scopeKey)
  if (!isMarker(stored)) return readSnapshot(scopeKey)
  const body = await idbGet<StagedDraftSnapshot>(bodyKey(scopeKey))
  if (!body || !Array.isArray(body.changes) || body.changes.length === 0) return null
  const pending = stored.pendingKey
    ? (await idbGet<PendingSave>(pendingKey(scopeKey))) ?? (body.pendingSave?.key === stored.pendingKey ? body.pendingSave : undefined)
    : body.pendingSave
  return { ...body, phase: stored.phase, pendingSave: pending }
}

export function clearSnapshot(scopeKey: string): void {
  try {
    localStorage.removeItem(storageKey(scopeKey))
  } catch {
    // ignore
  }
  void idbDelete(bodyKey(scopeKey))
  void idbDelete(pendingKey(scopeKey))
}

/** Flip an existing snapshot to 'committing' (called when a save starts, and again with the save's
 *  key before it is sent) so a crash mid-commit restores work that retries under that key. No-op if
 *  absent. Resolves once that is durable — a save waits for it before its request leaves. */
export function markSnapshotCommitting(scopeKey: string, pendingSave?: PendingSave): Promise<void> {
  const stored = readStored(scopeKey)
  if (!stored) return Promise.resolve()
  if (isMarker(stored)) {
    writeLocal(scopeKey, { ...stored, phase: 'committing', ...(pendingSave && { pendingKey: pendingSave.key }) })
    return pendingSave ? idbSet(pendingKey(scopeKey), pendingSave).then(() => undefined) : Promise.resolve()
  }
  if (!Array.isArray(stored.changes) || stored.changes.length === 0) return Promise.resolve()
  return persist({ ...stored, phase: 'committing', ...(pendingSave && { pendingSave }) }).durable.then(() => undefined)
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
