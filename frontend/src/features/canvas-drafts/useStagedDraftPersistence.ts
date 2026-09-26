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
import { overlayOnReplace, type MoveAfter } from '@/store/stagedOverlay'
import type { LineageEdge, LineageNode } from '@/store/canvas'
import type { NormalizedReferenceLayout } from '@/utils/referenceLayout'
import { layoutWriter } from '@/store/canvasLayoutBridge'
import { assignEntities } from '@/components/canvas/context-view/assignmentMutations'
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

/** Rebuild the per-change discard closure a restored change lost to JSON — the same undo the
 *  live change had, so discarding restored work puts the canvas back exactly as it does before a
 *  refresh (a restored rename used to stay on screen after its discard until the next reload).
 *  Layer/view changes still drop only their op-log row (their view config reverts on re-hydrate). */
function rebuildDiscard(change: SerializableChange): (() => void) | undefined {
  const cs = () => useCanvasStore.getState()
  switch (change.type) {
    case 'create_entity':
      return () => cs().removeNode(change.targetId)
    case 'create_edge':
      return () => cs().removeEdge(change.targetId)
    case 'rename_entity':
    case 'update_entity': {
      // `before` is the node's own data as it was (both staging paths record it that way).
      const before = change.before
      if (!before || typeof before !== 'object') return undefined
      return () => cs().updateNode(change.targetId, before as Partial<LineageNode['data']>)
    }
    case 'move_entity': {
      const after = change.after as MoveAfter
      const before = (change.before ?? {}) as { removedLinks?: LineageEdge[]; layout?: NormalizedReferenceLayout | null }
      return () => {
        if (after.edgeId) cs().removeEdge(after.edgeId)
        if (before.removedLinks?.length) cs().addEdges(before.removedLinks)
        if (before.layout) layoutWriter()?.persist(before.layout)
      }
    }
    default:
      return undefined
  }
}

function hydrateChange(sc: SerializableChange): StagedChange {
  return { ...sc, discard: rebuildDiscard(sc) }
}

/** Build a fresh snapshot from live store state, or null when nothing is staged. */
function buildSnapshot(scopeKey: string, branchId: string | null): StagedDraftSnapshot | null {
  const staged = useStagedChangesStore.getState()
  if (staged.changes.length === 0) return null
  const cs = useCanvasStore.getState()
  // Exactly what the overlay treats as pending: the snapshot carries every canvas copy it would keep.
  const pending = overlayOnReplace({ nodes: [], edges: [] }, { nodes: cs.nodes, edges: cs.edges }, staged.changes)
  const assignments = layoutWriter()?.current().assignments ?? {}
  const pins: Record<string, string> = {}
  for (const n of pending.nodes) {
    if (n.data?.isPending === 'create' && assignments[n.id]?.layerId) pins[n.id] = assignments[n.id].layerId
  }
  return {
    version: SNAPSHOT_VERSION,
    scopeKey,
    branchId,
    phase: 'staged',
    savedAt: 0,
    changes: staged.changes.map(toSerializableChange),
    pendingNodes: pending.nodes,
    pendingEdges: pending.edges,
    pins,
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

    // Lay the unsaved work ON TOP of the hydrated (committed) canvas by the same rule every later
    // load follows (stagedOverlay): the snapshot's copies win for what the work touches (a new node,
    // an edited one), and what it removed stays removed. Then the review op-log, so Save + the
    // review panel see the same changes — and every later reload keeps all of it.
    const changes = snapshot.changes.map(hydrateChange)
    const cs = useCanvasStore.getState()
    const { nodes, edges } = overlayOnReplace(
      { nodes: cs.nodes, edges: cs.edges },
      { nodes: snapshot.pendingNodes, edges: snapshot.pendingEdges },
      changes,
    )
    useCanvasStore.setState({
      nodes, edges, _nodeIndex: new Set(nodes.map((n) => n.id)), _edgeIndex: new Set(edges.map((e) => e.id)),
    })
    useStagedChangesStore.setState({
      changes,
      redoStack: [],
      applyStatus: 'idle',
      lastApplyResult: null,
    })
    // Unsaved top-level entities get their column back (see StagedDraftSnapshot.pins).
    const writer = layoutWriter()
    const pins = Object.entries(snapshot.pins ?? {})
    if (writer && pins.length > 0) {
      let layout = writer.current()
      for (const [urn, layerId] of pins) {
        if (!layout.assignments[urn] && layout.layers.some((l) => l.id === layerId)) {
          layout = assignEntities(layout, [urn], layerId)
        }
      }
      if (layout !== writer.current()) writer.persist(layout)
    }
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
