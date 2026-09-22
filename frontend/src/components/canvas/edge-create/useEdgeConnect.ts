/**
 * useEdgeConnect — interaction state machine for drawing a RAW edge between two
 * nodes on the custom (non-React-Flow) canvas. Two entry points feed it:
 *
 *   • Drag handle  — pointerdown on a node's connection handle starts a drag;
 *     the live pointer follows the cursor (ConnectionDragLayer renders it),
 *     pointerup over a target node opens the edge-type picker.
 *   • Connect mode — armConnect(sourceId) (context menu / 'C' key) arms a
 *     pending connection; the next click on a target node opens the picker.
 *
 * On a resolved target it transitions to `picking` and surfaces the popover at
 * the drop point. `confirm(edgeType)` hands the (source, target, edgeType) to
 * the caller (which stages a create_edge). Node ids are resolved from the DOM
 * via the `layer-node-*` ids the cards already carry.
 *
 * BULK: when the dragged card is part of a multi-selection (`groupOf`), the
 * drag carries the whole selection — dropping it on a card links every one of
 * them into that card. Dropping a single card on a card that is part of a
 * selection links it into the whole selection. Either drop hands off to
 * `onBulkDrop`, which opens the bulk card; a plain one-to-one link is
 * unchanged.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export type EdgeConnectMode = 'idle' | 'dragging' | 'armed' | 'picking'

export interface EdgeConnectState {
  mode: EdgeConnectMode
  sourceId: string | null
  targetId: string | null
  /** Every card the drag carries — the selection when the dragged card is in one. */
  sourceIds: string[]
  /** The card under the pointer while dragging (never one being dragged). */
  hoverId: string | null
  /** Live pointer in viewport coordinates (drag layer space). */
  pointer: { x: number; y: number } | null
  /** Where to anchor the edge-type popover (viewport coordinates). */
  pickerPos: { x: number; y: number } | null
}

const IDLE: EdgeConnectState = { mode: 'idle', sourceId: null, targetId: null, sourceIds: [], hoverId: null, pointer: null, pickerPos: null }

/** Resolve a viewport point to the node id under it (or null). */
function nodeIdAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)
  const card = el?.closest('[id^="layer-node-"]') as HTMLElement | null
  return card ? card.id.slice('layer-node-'.length) : null
}

export interface UseEdgeConnectOptions {
  /** Called when the user confirms an edge type for the resolved endpoints. */
  onConnect: (sourceId: string, targetId: string, edgeType: string) => void
  /** The multi-selection a card belongs to (2+ ids), or null. */
  groupOf?: (id: string) => readonly string[] | null
  /** A drop that links more than one pair: the selection feeds `picked`, or
   *  `picked` feeds the selection. */
  onBulkDrop?: (drop: { direction: 'selection-feeds' | 'feeds-selection'; picked: string[]; at: { x: number; y: number } }) => void
}

export function useEdgeConnect({ onConnect, groupOf, onBulkDrop }: UseEdgeConnectOptions) {
  const [state, setState] = useState<EdgeConnectState>(IDLE)
  // Mirror for document listeners (avoids stale closures without re-binding).
  const ref = useRef(state)
  ref.current = state
  const bulk = useRef({ groupOf, onBulkDrop })
  useLayoutEffect(() => { bulk.current = { groupOf, onBulkDrop } })

  const cancel = useCallback(() => setState(IDLE), [])

  const beginDrag = useCallback((sourceId: string, start: { x: number; y: number }) => {
    const { groupOf: g, onBulkDrop: drop } = bulk.current
    const group = drop ? g?.(sourceId) : null
    const sourceIds = group && group.length > 1 ? [...group] : [sourceId]
    setState({ mode: 'dragging', sourceId, targetId: null, sourceIds, hoverId: null, pointer: start, pickerPos: null })
  }, [])

  const armConnect = useCallback((sourceId: string) => {
    setState({ mode: 'armed', sourceId, targetId: null, sourceIds: [sourceId], hoverId: null, pointer: null, pickerPos: null })
  }, [])

  const confirm = useCallback((edgeType: string) => {
    const s = ref.current
    if (s.sourceId && s.targetId) onConnect(s.sourceId, s.targetId, edgeType)
    setState(IDLE)
  }, [onConnect])

  // Resolve a target endpoint and either open the picker or cancel.
  const resolveTarget = useCallback((x: number, y: number) => {
    const s = ref.current
    const targetId = nodeIdAt(x, y)
    if (!targetId || targetId === s.sourceId || s.sourceIds.includes(targetId)) {
      setState(IDLE)
      return
    }
    const { groupOf: g, onBulkDrop: drop } = bulk.current
    if (drop && s.mode === 'dragging') {
      // The selection, dragged onto a card: it feeds that card.
      if (s.sourceIds.length > 1) {
        setState(IDLE)
        drop({ direction: 'selection-feeds', picked: [targetId], at: { x, y } })
        return
      }
      // One card dropped on a selected card: it feeds the whole selection.
      const targets = g?.(targetId)
      if (s.sourceId && targets && targets.length > 1 && !targets.includes(s.sourceId)) {
        setState(IDLE)
        drop({ direction: 'feeds-selection', picked: [s.sourceId], at: { x, y } })
        return
      }
    }
    setState({ ...s, mode: 'picking', targetId, hoverId: null, pointer: null, pickerPos: { x, y } })
  }, [])

  // Drag listeners: follow the pointer, resolve on release.
  useEffect(() => {
    if (state.mode !== 'dragging') return
    const onMove = (e: PointerEvent) => setState((s) => {
      if (s.mode !== 'dragging') return s
      const over = nodeIdAt(e.clientX, e.clientY)
      const hoverId = over && over !== s.sourceId && !s.sourceIds.includes(over) ? over : null
      return { ...s, hoverId, pointer: { x: e.clientX, y: e.clientY } }
    })
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setState(IDLE) }
    const onUp = (e: PointerEvent) => resolveTarget(e.clientX, e.clientY)
    const onCancel = () => setState(IDLE)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    window.addEventListener('pointercancel', onCancel, { once: true })
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey)
    }
  }, [state.mode, resolveTarget])

  // Armed listeners: next click picks the target; Escape cancels.
  useEffect(() => {
    if (state.mode !== 'armed') return
    const onClick = (e: MouseEvent) => { e.preventDefault(); resolveTarget(e.clientX, e.clientY) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setState(IDLE) }
    // Delay binding so the click that armed it (if any) doesn't immediately resolve.
    const t = setTimeout(() => {
      window.addEventListener('click', onClick, { once: true, capture: true })
      window.addEventListener('keydown', onKey)
    }, 0)
    return () => { clearTimeout(t); window.removeEventListener('click', onClick, true); window.removeEventListener('keydown', onKey) }
  }, [state.mode, resolveTarget])

  return { state, beginDrag, armConnect, confirm, cancel }
}
