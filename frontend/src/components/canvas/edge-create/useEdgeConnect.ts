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
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export type EdgeConnectMode = 'idle' | 'dragging' | 'armed' | 'picking'

export interface EdgeConnectState {
  mode: EdgeConnectMode
  sourceId: string | null
  targetId: string | null
  /** Live pointer in viewport coordinates (drag layer space). */
  pointer: { x: number; y: number } | null
  /** Where to anchor the edge-type popover (viewport coordinates). */
  pickerPos: { x: number; y: number } | null
}

const IDLE: EdgeConnectState = { mode: 'idle', sourceId: null, targetId: null, pointer: null, pickerPos: null }

/** Resolve a viewport point to the node id under it (or null). */
function nodeIdAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)
  const card = el?.closest('[id^="layer-node-"]') as HTMLElement | null
  return card ? card.id.slice('layer-node-'.length) : null
}

export interface UseEdgeConnectOptions {
  /** Called when the user confirms an edge type for the resolved endpoints. */
  onConnect: (sourceId: string, targetId: string, edgeType: string) => void
}

export function useEdgeConnect({ onConnect }: UseEdgeConnectOptions) {
  const [state, setState] = useState<EdgeConnectState>(IDLE)
  // Mirror for document listeners (avoids stale closures without re-binding).
  const ref = useRef(state)
  ref.current = state

  const cancel = useCallback(() => setState(IDLE), [])

  const beginDrag = useCallback((sourceId: string, start: { x: number; y: number }) => {
    setState({ mode: 'dragging', sourceId, targetId: null, pointer: start, pickerPos: null })
  }, [])

  const armConnect = useCallback((sourceId: string) => {
    setState({ mode: 'armed', sourceId, targetId: null, pointer: null, pickerPos: null })
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
    if (!targetId || targetId === s.sourceId) {
      setState(IDLE)
      return
    }
    setState({ ...s, mode: 'picking', targetId, pointer: null, pickerPos: { x, y } })
  }, [])

  // Drag listeners: follow the pointer, resolve on release.
  useEffect(() => {
    if (state.mode !== 'dragging') return
    const onMove = (e: PointerEvent) => setState((s) => (s.mode === 'dragging' ? { ...s, pointer: { x: e.clientX, y: e.clientY } } : s))
    const onUp = (e: PointerEvent) => resolveTarget(e.clientX, e.clientY)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
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
