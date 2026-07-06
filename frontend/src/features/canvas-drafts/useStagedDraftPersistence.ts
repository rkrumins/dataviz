/**
 * useStagedDraftPersistence — wires the staged-draft snapshot (localStorage)
 * to the live stores so unsaved Context View work survives a refresh.
 *
 * Mount it once per canvas (CanvasRouter). It:
 *  - On scope resolve, attempts a restore: a safe snapshot (right branch, not
 *    mid-commit) is replayed onto the canvas + the review op-log, and its
 *    count is surfaced for the "Restored N unsaved changes" banner; an unsafe
 *    one is discarded (see reconcileSnapshot).
 *  - Subscribes to the staged store and persists a debounced snapshot on every
 *    change, marks it 'committing' while a save runs, and clears it the moment
 *    the store empties (after a successful save OR a discard-all) — so the save
 *    path itself needs no edit.
 *
 * Returns the restored count (for the banner) + a discardAll that clears the
 * staged work AND its snapshot in one shot.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useCanvasStore } from '@/store/canvas'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import {
  clearSnapshot,
  markSnapshotCommitting,
  readSnapshot,
  reconcileSnapshot,
  toSerializableChange,
  writeSnapshot,
  type SerializableChange,
  type StagedDraftSnapshot,
} from './stagedDraftPersistence'

const SNAPSHOT_VERSION = 1
const WRITE_DEBOUNCE_MS = 600

/** Rebuild the per-change discard closure a restored change lost to JSON. The
 *  builder flow is dominated by create_entity/create_edge, whose discard is
 *  exactly "remove the optimistic node/edge"; other types drop their op-log
 *  row on discard (their visual state reverts on the next save / re-hydrate). */
function rebuildDiscard(change: SerializableChange): (() => void) | undefined {
  if (change.type === 'create_entity') {
    return () => useCanvasStore.getState().removeNode(change.targetId)
  }
  if (change.type === 'create_edge') {
    return () => useCanvasStore.getState().removeEdge(change.targetId)
  }
  return undefined
}

function hydrateChange(sc: SerializableChange): StagedChange {
  return { ...sc, discard: rebuildDiscard(sc) }
}

export function useStagedDraftPersistence(
  scopeKey: string | null,
  currentBranchId: string | null,
) {
  const [restoredCount, setRestoredCount] = useState(0)
  const dismissRestored = useCallback(() => setRestoredCount(0), [])

  // Restore runs at most once per scope key.
  const restoredForKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!scopeKey) return
    if (restoredForKeyRef.current === scopeKey) return
    restoredForKeyRef.current = scopeKey

    const snapshot = readSnapshot(scopeKey)
    const verdict = reconcileSnapshot(snapshot, currentBranchId)
    if (verdict === 'discard') {
      clearSnapshot(scopeKey)
      return
    }
    if (verdict === 'noop' || !snapshot) return

    // Replay: optimistic canvas first (exact positions/badges), then the
    // review op-log so Save + the review panel see the same changes.
    const cs = useCanvasStore.getState()
    if (snapshot.pendingNodes.length) cs.addNodes(snapshot.pendingNodes)
    if (snapshot.pendingEdges.length) cs.addEdges(snapshot.pendingEdges)
    useStagedChangesStore.setState({
      changes: snapshot.changes.map(hydrateChange),
      redoStack: [],
      applyStatus: 'idle',
      lastApplyResult: null,
    })
    setRestoredCount(snapshot.changes.length)
  }, [scopeKey, currentBranchId])

  // Persist on change; mark committing during a save; clear when empty.
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!scopeKey) return
    const persistNow = () => {
      const staged = useStagedChangesStore.getState()
      if (staged.changes.length === 0) {
        clearSnapshot(scopeKey)
        return
      }
      const cs = useCanvasStore.getState()
      const snapshot: StagedDraftSnapshot = {
        version: SNAPSHOT_VERSION,
        scopeKey,
        branchId: currentBranchId,
        phase: 'staged',
        savedAt: 0, // stamped at write time is unnecessary; ordering is by store state
        changes: staged.changes.map(toSerializableChange),
        pendingNodes: cs.nodes.filter((n) => n.data?.isPending),
        pendingEdges: cs.edges.filter((e) => e.data?.isPending),
      }
      writeSnapshot(snapshot)
    }

    const unsub = useStagedChangesStore.subscribe((state, prev) => {
      // A save going in-flight: freeze the snapshot as 'committing' so a crash
      // between the server commit and the store-clear can't restore committed
      // work (would duplicate it).
      if (state.applyStatus === 'applying' && prev.applyStatus !== 'applying') {
        markSnapshotCommitting(scopeKey)
        return
      }
      if (state.changes === prev.changes) return
      if (state.changes.length === 0) {
        if (writeTimerRef.current) clearTimeout(writeTimerRef.current)
        clearSnapshot(scopeKey)
        return
      }
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current)
      writeTimerRef.current = setTimeout(persistNow, WRITE_DEBOUNCE_MS)
    })

    return () => {
      unsub()
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current)
    }
  }, [scopeKey, currentBranchId])

  // Clear ALL uncommitted staged work (the client review layer) + its
  // snapshot. Leaves anything already committed to the draft branch intact —
  // that's a separate "abandon draft" action.
  const discardAllStaged = useCallback(() => {
    useStagedChangesStore.getState().discardAll()
    if (scopeKey) clearSnapshot(scopeKey)
    setRestoredCount(0)
  }, [scopeKey])

  return { restoredCount, dismissRestored, discardAllStaged }
}
