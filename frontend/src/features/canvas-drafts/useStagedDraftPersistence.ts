/**
 * useStagedDraftPersistence — wires the staged-draft snapshot (localStorage)
 * to the live stores so unsaved Context View work survives a refresh.
 *
 * Mount it once per canvas (CanvasRouter). It:
 *  - Once initial hydration COMPLETES, attempts a restore: a safe snapshot
 *    (right branch, not mid-commit) is appended onto the canvas + the review
 *    op-log, its count surfaced for the "Restored N unsaved changes" banner;
 *    an unsafe one is discarded. Restore waits for hydration on purpose — the
 *    hydration effect clears the canvas and then replaces it with server
 *    (committed) nodes, so a restore that ran earlier would be wiped. Appending
 *    after hydration layers the unsaved delta on top of the committed draft.
 *  - Persists a debounced snapshot on every change, marks it 'committing'
 *    while a save runs, clears it when the store empties (after a successful
 *    save OR a discard-all — so the save path needs no edit), and flushes
 *    synchronously on beforeunload so the last edits in the debounce window
 *    aren't lost to a fast refresh.
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

/** Build a fresh snapshot from live store state, or null when nothing is staged. */
function buildSnapshot(scopeKey: string, branchId: string | null): StagedDraftSnapshot | null {
  const staged = useStagedChangesStore.getState()
  if (staged.changes.length === 0) return null
  const cs = useCanvasStore.getState()
  return {
    version: SNAPSHOT_VERSION,
    scopeKey,
    branchId,
    phase: 'staged',
    savedAt: 0,
    changes: staged.changes.map(toSerializableChange),
    pendingNodes: cs.nodes.filter((n) => n.data?.isPending),
    pendingEdges: cs.edges.filter((e) => e.data?.isPending),
  }
}

export function useStagedDraftPersistence(
  scopeKey: string | null,
  currentBranchId: string | null,
  hydrationComplete: boolean,
) {
  const [restoredCount, setRestoredCount] = useState(0)
  const dismissRestored = useCallback(() => setRestoredCount(0), [])

  // Restore runs at most once per scope key, and only AFTER hydration settles
  // (else the hydration's setGraph(server) would overwrite the restored nodes).
  const restoredForKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!scopeKey || !hydrationComplete) return
    if (restoredForKeyRef.current === scopeKey) return
    restoredForKeyRef.current = scopeKey

    const snapshot = readSnapshot(scopeKey)
    const verdict = reconcileSnapshot(snapshot, currentBranchId)
    if (verdict === 'discard') {
      clearSnapshot(scopeKey)
      return
    }
    if (verdict === 'noop' || !snapshot) return

    // Append the unsaved delta ON TOP of the hydrated (committed) canvas:
    // optimistic nodes/edges first (exact positions/badges), then the review
    // op-log so Save + the review panel see the same changes.
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
  }, [scopeKey, currentBranchId, hydrationComplete])

  // Persist on change; mark committing during a save; clear when empty.
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!scopeKey) return

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
      writeTimerRef.current = setTimeout(() => {
        const snapshot = buildSnapshot(scopeKey, currentBranchId)
        if (snapshot) writeSnapshot(snapshot)
        else clearSnapshot(scopeKey)
      }, WRITE_DEBOUNCE_MS)
    })

    // Flush synchronously on unload so edits still inside the debounce window
    // survive a fast refresh (the debounced timer would never fire).
    const flush = () => {
      const snapshot = buildSnapshot(scopeKey, currentBranchId)
      if (snapshot) writeSnapshot(snapshot)
    }
    window.addEventListener('beforeunload', flush)

    return () => {
      unsub()
      window.removeEventListener('beforeunload', flush)
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
