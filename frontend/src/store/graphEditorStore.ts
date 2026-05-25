/**
 * graphEditorStore — the persisted, per-branch working set for the
 * authored-graph editor.
 *
 * Generalizes the proven `stagedChangesStore` patterns (per-object
 * coalescing, undo/redo, temp-id resolution) into a backend-synced,
 * branch-aware, ref-aware store. `stagedChangesStore` is left untouched
 * (still used by the Context View).
 *
 * This module is pure state logic (no React, no fetch) so it is fully
 * Vitest-testable; the page layer wires it to versionControlService +
 * React Query mutations.
 */
import { create } from 'zustand'

export type EditorChangeType =
  | 'add_node' | 'update_node' | 'delete_node'
  | 'add_edge' | 'update_edge' | 'delete_edge'

export type EditorObjectKind = 'node' | 'edge'

export interface EditorOp {
  /** Stable per-op id (also used as React key). */
  opId: string
  changeType: EditorChangeType
  objectKind: EditorObjectKind
  /** Real id, or a `staged_*` temp id for not-yet-committed creates. */
  objectId: string
  /** Resolved final content for add/update; `{ key }` for delete. */
  payload: Record<string, unknown>
  /** First-seen committed value, preserved across coalescing so undo
   * restores the right baseline. */
  before?: Record<string, unknown> | null
  summary: string
  ts: number
}

export type SyncState =
  | 'clean'
  | 'dirty'
  | 'committing'
  | 'remote_advanced'
  | 'conflict'
  | 'error'

/**
 * One per-entity conflict surfaced by `/working-set/pull`. Mirrors the
 * server-side `PullConflict` shape — the staged op is left in the
 * working set with its original `base_content_hash` so the user can
 * pick a resolution without losing work.
 */
export interface PendingConflict {
  objectKind: 'node' | 'edge'
  objectId: string
  conflictClass:
    | 'edit_edit'
    | 'edit_delete'
    | 'delete_edit'
    | 'add_add'
  baseContentHash: string | null
  currentContentHash: string | null
  stagedChangeType: string
}

export interface GraphEditorState {
  graphId: string | null
  branch: string
  /** Commit the working set forked from (the optimistic-concurrency
   * token sent on commit). */
  baseCommitId: string | null
  ops: EditorOp[]
  undoStack: EditorOp[]
  redoStack: EditorOp[]
  syncState: SyncState
  /** Set when the server reports the ref moved under us. */
  conflictHead: string | null
  /** Most recent commit_id seen on the branch via SSE that we do NOT
   * yet have as our base. Null once we refresh / pull onto it. */
  remoteHead: string | null
  /** Highest ws_change_version reported by the working_set_advanced
   * SSE event from another tab of this user. Null if no such signal
   * has been observed yet. */
  remoteWsVersion: number | null
  /** Per-entity conflicts from the most recent `/working-set/pull`.
   * Cleared after the user resolves and re-commits, or on `reset`. */
  pendingConflicts: PendingConflict[]

  init: (graphId: string, branch: string, baseCommitId: string | null) => void
  applyOp: (
    op: Omit<EditorOp, 'opId' | 'ts'> & { opId?: string },
  ) => void
  undo: () => boolean
  redo: () => boolean
  /** Map server-assigned real ids over `staged_*` temp ids after a
   * draft save / commit. */
  reconcileTempIds: (mapping: Record<string, string>) => void
  onRefMoved: (currentHead: string | null) => void
  /** Another tab / user committed on this branch. Idempotent: an echo
   * of our own commit (commit_id === baseCommitId) is ignored. While
   * dirty/committing/conflict the syncState is preserved (we just
   * record `remoteHead` so the UI can show "N commits ahead"). */
  onRemoteCommit: (commitId: string) => void
  /** Another of this user's tabs staged on this branch. Same-user
   * signal — the listener should refetch the working set. The store
   * reaction is intentionally minimal (no automatic refetch here;
   * that's the page layer's job). Tracks the latest version seen so
   * a stale notification can be detected. */
  onRemoteWorkingSetAdvanced: (wsChangeVersion: number) => void
  /** Commit succeeded: clear ops, advance base, back to clean. */
  clearAfterCommit: (newCommitId: string) => void
  setSyncState: (s: SyncState) => void
  /** V1-6: apply the result of `pullWorkingSet`. Advances baseCommitId
   * to the new HEAD and stores per-entity conflicts (if any) so the
   * UI can render the resolver. Sets syncState to `conflict` when
   * conflicts exist, `clean` when the working set is empty after
   * pull, or `dirty` otherwise. */
  applyPullResult: (result: {
    new_base: string | null
    rebased: number
    dropped: number
    conflicts: PendingConflict[]
  }) => void
  /** Drop one entry from `pendingConflicts` once the user resolves
   * it. The actual staged op update / re-stage is handled by the
   * caller (it depends on which resolution the user picked). */
  dismissConflict: (objectKind: 'node' | 'edge', objectId: string) => void
  summary: () => Record<EditorChangeType, number>
  reset: () => void
}

let _seq = 0
const nextOpId = () => `op_${Date.now().toString(36)}_${(_seq++).toString(36)}`

const isAdd = (t: EditorChangeType) => t.startsWith('add_')
const isDelete = (t: EditorChangeType) => t.startsWith('delete_')

export const useGraphEditorStore = create<GraphEditorState>((set, get) => ({
  graphId: null,
  branch: 'main',
  baseCommitId: null,
  ops: [],
  undoStack: [],
  redoStack: [],
  syncState: 'clean',
  conflictHead: null,
  remoteHead: null,
  remoteWsVersion: null,
  pendingConflicts: [],

  init: (graphId, branch, baseCommitId) =>
    set({
      graphId,
      branch,
      baseCommitId,
      ops: [],
      undoStack: [],
      redoStack: [],
      syncState: 'clean',
      conflictHead: null,
      remoteHead: null,
      remoteWsVersion: null,
      pendingConflicts: [],
    }),

  applyOp: (input) => {
    const ops = [...get().ops]
    const idx = ops.findIndex(
      (o) =>
        o.objectKind === input.objectKind && o.objectId === input.objectId,
    )

    // add-then-delete of a never-committed object cancels out entirely
    // (no net change to commit) — mirrors `git add` then `git rm`.
    if (
      idx >= 0 &&
      isAdd(ops[idx].changeType) &&
      isDelete(input.changeType)
    ) {
      ops.splice(idx, 1)
      set({
        ops,
        syncState: ops.length ? 'dirty' : 'clean',
      })
      return
    }

    if (idx >= 0) {
      // Coalesce: keep opId + the ORIGINAL `before` so undo restores
      // the committed baseline, not an intermediate edit.
      ops[idx] = {
        ...ops[idx],
        changeType: input.changeType,
        payload: input.payload,
        summary: input.summary,
        ts: Date.now(),
      }
    } else {
      ops.push({
        opId: input.opId ?? nextOpId(),
        changeType: input.changeType,
        objectKind: input.objectKind,
        objectId: input.objectId,
        payload: input.payload,
        before: input.before ?? null,
        summary: input.summary,
        ts: Date.now(),
      })
    }
    set({ ops, syncState: 'dirty', redoStack: [] })
  },

  undo: () => {
    const { ops, undoStack, redoStack } = get()
    if (ops.length === 0) return false
    const last = ops[ops.length - 1]
    set({
      ops: ops.slice(0, -1),
      undoStack: [...undoStack, last],
      redoStack: [...redoStack, last],
      syncState: ops.length - 1 ? 'dirty' : 'clean',
    })
    return true
  },

  redo: () => {
    const { redoStack, ops } = get()
    if (redoStack.length === 0) return false
    const op = redoStack[redoStack.length - 1]
    set({
      ops: [...ops, op],
      redoStack: redoStack.slice(0, -1),
      syncState: 'dirty',
    })
    return true
  },

  reconcileTempIds: (mapping) => {
    if (!Object.keys(mapping).length) return
    set({
      ops: get().ops.map((o) => {
        const real = mapping[o.objectId]
        if (!real) return o
        const payload = { ...o.payload }
        if (payload.key === o.objectId) payload.key = real
        return { ...o, objectId: real, payload }
      }),
    })
  },

  onRefMoved: (currentHead) =>
    set({
      syncState: 'conflict',
      conflictHead: currentHead,
      remoteHead: currentHead,
    }),

  onRemoteCommit: (commitId) => {
    const s = get()
    if (commitId === s.baseCommitId) return // echo of our own commit
    if (commitId === s.remoteHead) return   // duplicate notification
    // Always record the new remote head. Only downgrade `clean` →
    // `remote_advanced`; preserve dirty/committing/conflict (the user
    // already has work in progress; the UI uses `remoteHead` to gate
    // the commit button in those states).
    if (s.syncState === 'clean') {
      set({ syncState: 'remote_advanced', remoteHead: commitId })
    } else {
      set({ remoteHead: commitId })
    }
  },

  onRemoteWorkingSetAdvanced: (wsChangeVersion) => {
    const cur = get().remoteWsVersion
    // Ignore older / equal notifications (events may arrive out of
    // order on reconnect).
    if (cur !== null && wsChangeVersion <= cur) return
    set({ remoteWsVersion: wsChangeVersion })
  },

  clearAfterCommit: (newCommitId) =>
    set({
      ops: [],
      undoStack: [],
      redoStack: [],
      baseCommitId: newCommitId,
      syncState: 'clean',
      conflictHead: null,
      remoteHead: null,
      remoteWsVersion: null,
      pendingConflicts: [],
    }),

  setSyncState: (s) => set({ syncState: s }),

  applyPullResult: (result) => {
    const s = get()
    const hasConflicts = result.conflicts.length > 0
    let nextSync: SyncState
    if (hasConflicts) {
      nextSync = 'conflict'
    } else if (s.ops.length > 0) {
      nextSync = 'dirty'
    } else {
      nextSync = 'clean'
    }
    set({
      baseCommitId: result.new_base,
      pendingConflicts: result.conflicts,
      syncState: nextSync,
      // We've now reconciled against the server's head — clear the
      // "remote_advanced" markers so the UI shows clean / dirty /
      // conflict (depending on the result), not "updates available".
      conflictHead: null,
      remoteHead: null,
    })
  },

  dismissConflict: (objectKind, objectId) => {
    const remaining = get().pendingConflicts.filter(
      (c) => !(c.objectKind === objectKind && c.objectId === objectId),
    )
    set({
      pendingConflicts: remaining,
      // If the user worked through every conflict, fall back to dirty
      // (their ops are still pending commit) or clean.
      syncState:
        remaining.length > 0
          ? 'conflict'
          : get().ops.length > 0
            ? 'dirty'
            : 'clean',
    })
  },

  summary: () => {
    const acc = {
      add_node: 0, update_node: 0, delete_node: 0,
      add_edge: 0, update_edge: 0, delete_edge: 0,
    } as Record<EditorChangeType, number>
    for (const o of get().ops) acc[o.changeType] += 1
    return acc
  },

  reset: () =>
    set({
      graphId: null,
      branch: 'main',
      baseCommitId: null,
      ops: [],
      undoStack: [],
      redoStack: [],
      syncState: 'clean',
      conflictHead: null,
      remoteHead: null,
      remoteWsVersion: null,
      pendingConflicts: [],
    }),
}))
