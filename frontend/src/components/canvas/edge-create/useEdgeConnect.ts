/**
 * useEdgeConnect — interaction state machine for drawing a RAW edge between two
 * nodes on the custom (non-React-Flow) canvas. Three entry points feed it:
 *
 *   • Drag handle  — pointerdown on a node's connection handle starts a drag;
 *     the live pointer follows the cursor (ConnectionDragLayer renders it),
 *     pointerup over a target node opens the edge-type picker. A press that
 *     barely moves is a CLICK: it arms the connection instead of cancelling it,
 *     so nobody has to hold the mouse down across a wide canvas.
 *   • Connect mode — armConnect(sourceId) (context menu / 'C' key / a click on
 *     the handle) arms a pending connection; the next click on a card picks the
 *     target. Nothing is held, so the reader can scroll, jump with the Layer
 *     Strip or search for a target that is off screen. Only a click on a card's
 *     BODY is taken — its own controls (expand, add child) keep working — and a
 *     click anywhere else passes through and nudges the reminder rather than
 *     silently cancelling. ⌘/Ctrl-click collects several targets; Enter (or a
 *     plain click on the last one) links them all.
 *   • Connect tool — setTool(true) (the toolbar, or 'C' with nothing selected):
 *     a click on a card arms it as the source, and after each link the tool
 *     waits for the next source, so a run of links is click, click, click, click.
 *
 * On a resolved target it transitions to `picking` and surfaces the popover at
 * the drop point — unless `singleTypeFor` names the one relationship that fits,
 * which links at once. `confirm(edgeType)` hands the (source, target, edgeType)
 * to the caller (which stages a create_edge). Node ids are resolved from the DOM
 * via the `layer-node-*` ids the cards already carry.
 *
 * While armed, the pointer is NOT kept in this state: ConnectionDragLayer
 * follows it on its own, so a connection held open for minutes never re-renders
 * the canvas on every pointer move. State changes only on discrete steps.
 *
 * BULK: when the dragged card is part of a multi-selection (`groupOf`), the
 * drag carries the whole selection — dropping it on a card links every one of
 * them into that card. Dropping a single card on a card that is part of a
 * selection links it into the whole selection. Either drop hands off to
 * `onBulkDrop`, which opens the bulk card; a plain one-to-one link is
 * unchanged. Arming behaves the same way.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export type EdgeConnectMode = 'idle' | 'dragging' | 'armed' | 'picking'

export interface EdgeConnectState {
  mode: EdgeConnectMode
  sourceId: string | null
  targetId: string | null
  /** Every card the connection carries — the selection when the card is in one. */
  sourceIds: string[]
  /** The card under the pointer while dragging (never one being dragged). */
  hoverId: string | null
  /** Live pointer in viewport coordinates while dragging (drag layer space). */
  pointer: { x: number; y: number } | null
  /** Where to anchor the edge-type popover (viewport coordinates). */
  pickerPos: { x: number; y: number } | null
  /** The Connect tool is on: a click on a card starts a connection, and the
   *  tool stays on after each link. */
  tool: boolean
  /** Armed from one card: targets collected with ⌘/Ctrl-click, in click order. */
  targets: string[]
  /** Bumped by a click that landed on no card while armed — the reminder's cue to pulse. */
  nudge: number
}

const IDLE: EdgeConnectState = {
  mode: 'idle', sourceId: null, targetId: null, sourceIds: [], hoverId: null, pointer: null,
  pickerPos: null, tool: false, targets: [], nudge: 0,
}

/** A press on the handle that moves less than this is a click: it arms rather than drags. */
export const CLICK_SLOP_PX = 4

const CARD = '[id^="layer-node-"]'
/** A card's own controls keep their clicks while connecting (expand, add child, the handle). */
const CARD_CONTROL = 'button, a, input, select, textarea, [role="button"], [contenteditable="true"]'

/** Resolve a viewport point to the node id under it (or null). */
function nodeIdAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)
  const card = el?.closest(CARD) as HTMLElement | null
  return card ? card.id.slice('layer-node-'.length) : null
}

/** The card a click lands on — its body, not one of its controls — or null. */
function cardBodyOf(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  const card = target.closest(CARD) as HTMLElement | null
  if (!card) return null
  const control = target.closest(CARD_CONTROL)
  if (control && card.contains(control)) return null
  return card.id.slice('layer-node-'.length)
}

/** Back to rest — which, with the tool on, means waiting for the next source. */
function settle(s: EdgeConnectState): EdgeConnectState {
  return { ...IDLE, tool: s.tool, nudge: s.nudge }
}

export interface UseEdgeConnectOptions {
  /** Called when an edge type is settled for the resolved endpoints — chosen in
   *  the picker, or `auto` when it was the only relationship that fit. */
  onConnect: (sourceId: string, targetId: string, edgeType: string, how?: { auto: boolean }) => void
  /** The multi-selection a card belongs to (2+ ids), or null. */
  groupOf?: (id: string) => readonly string[] | null
  /** A drop that links more than one pair: the selection feeds `picked`, or
   *  `picked` feeds the selection. */
  onBulkDrop?: (drop: { direction: 'selection-feeds' | 'feeds-selection'; picked: string[]; at: { x: number; y: number } }) => void
  /** The one relationship that fits source → target, when exactly one does:
   *  the link is made at once instead of asking. Null → the picker. */
  singleTypeFor?: (sourceId: string, targetId: string) => string | null
  /** Several targets collected while armed from one card: link the source into each. */
  onMultiTarget?: (link: { sourceId: string; targets: string[]; at: { x: number; y: number } }) => void
}

/** The cards a connection from `sourceId` carries: its selection, when it is in one. */
function carriedBy(sourceId: string, o: Pick<UseEdgeConnectOptions, 'groupOf' | 'onBulkDrop'>): string[] {
  const group = o.onBulkDrop ? o.groupOf?.(sourceId) : null
  return group && group.length > 1 ? [...group] : [sourceId]
}

export function useEdgeConnect({ onConnect, groupOf, onBulkDrop, singleTypeFor, onMultiTarget }: UseEdgeConnectOptions) {
  const [state, setState] = useState<EdgeConnectState>(IDLE)
  // Mirror for document listeners (avoids stale closures without re-binding).
  const ref = useRef(state)
  ref.current = state
  const opts = useRef({ onConnect, groupOf, onBulkDrop, singleTypeFor, onMultiTarget })
  useLayoutEffect(() => { opts.current = { onConnect, groupOf, onBulkDrop, singleTypeFor, onMultiTarget } })
  /** Where the current drag was pressed — a release this close to it is a click. */
  const origin = useRef<{ x: number; y: number } | null>(null)
  /** The last pointer position while armed — where a bulk link's card appears. */
  const lastPointer = useRef<{ x: number; y: number } | null>(null)

  const cancel = useCallback(() => setState((s) => settle(s)), [])
  /** Drop the targets collected so far; the connection stays armed. */
  const clearTargets = useCallback(() => setState((s) => (s.targets.length ? { ...s, targets: [] } : s)), [])

  /** Turn the Connect tool on or off. Off drops any connection in progress. */
  const setTool = useCallback((on: boolean) => {
    setState((s) => (on ? { ...settle(s), tool: true } : { ...IDLE, nudge: s.nudge }))
  }, [])
  const toggleTool = useCallback(() => {
    setState((s) => (s.tool ? { ...IDLE, nudge: s.nudge } : { ...settle(s), tool: true }))
  }, [])

  const beginDrag = useCallback((sourceId: string, start: { x: number; y: number }) => {
    origin.current = start
    setState((s) => ({
      ...settle(s), mode: 'dragging', sourceId, sourceIds: carriedBy(sourceId, opts.current), pointer: start,
    }))
  }, [])

  const armConnect = useCallback((sourceId: string, at?: { x: number; y: number }) => {
    lastPointer.current = at ?? null
    setState((s) => ({ ...settle(s), mode: 'armed', sourceId, sourceIds: carriedBy(sourceId, opts.current) }))
  }, [])

  const confirm = useCallback((edgeType: string) => {
    const s = ref.current
    if (s.sourceId && s.targetId) opts.current.onConnect(s.sourceId, s.targetId, edgeType)
    setState(settle(s))
  }, [])

  // Resolve a target endpoint and either link, open the picker, or cancel.
  // `hit` is the card already known (a click on it); otherwise the point is read.
  const resolveTarget = useCallback((x: number, y: number, hit?: string) => {
    const s = ref.current
    const targetId = hit ?? nodeIdAt(x, y)
    if (!targetId || targetId === s.sourceId || s.sourceIds.includes(targetId)) {
      setState(settle(s))
      return
    }
    const { groupOf: g, onBulkDrop: drop, singleTypeFor: single, onConnect: connect } = opts.current
    if (drop && (s.mode === 'dragging' || s.mode === 'armed')) {
      // The selection, carried onto a card: it feeds that card.
      if (s.sourceIds.length > 1) {
        setState(settle(s))
        drop({ direction: 'selection-feeds', picked: [targetId], at: { x, y } })
        return
      }
      // One card onto a selected card: it feeds the whole selection.
      const targets = g?.(targetId)
      if (s.sourceId && targets && targets.length > 1 && !targets.includes(s.sourceId)) {
        setState(settle(s))
        drop({ direction: 'feeds-selection', picked: [s.sourceId], at: { x, y } })
        return
      }
    }
    // Only one relationship fits: nothing to ask.
    const only = s.sourceId ? single?.(s.sourceId, targetId) ?? null : null
    if (s.sourceId && only) {
      setState(settle(s))
      connect(s.sourceId, targetId, only, { auto: true })
      return
    }
    setState({ ...s, mode: 'picking', targetId, targets: [], hoverId: null, pointer: null, pickerPos: { x, y } })
  }, [])

  /** Link the source into every collected target (Enter, or "Link N" on the reminder). */
  const commitTargets = useCallback((at?: { x: number; y: number }) => {
    const s = ref.current
    if (s.mode !== 'armed' || !s.sourceId || s.targets.length === 0) return
    const where = at ?? lastPointer.current ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    if (s.targets.length === 1) {
      resolveTarget(where.x, where.y, s.targets[0])
      return
    }
    setState(settle(s))
    opts.current.onMultiTarget?.({ sourceId: s.sourceId, targets: s.targets, at: where })
  }, [resolveTarget])

  // Drag listeners: follow the pointer, resolve on release.
  useEffect(() => {
    if (state.mode !== 'dragging') return
    const onMove = (e: PointerEvent) => setState((s) => {
      if (s.mode !== 'dragging') return s
      const over = nodeIdAt(e.clientX, e.clientY)
      const hoverId = over && over !== s.sourceId && !s.sourceIds.includes(over) ? over : null
      return { ...s, hoverId, pointer: { x: e.clientX, y: e.clientY } }
    })
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setState((s) => settle(s)) }
    const onUp = (e: PointerEvent) => {
      // Pressed on one card, released over another: the browser fires the
      // click on their common ancestor — the canvas background, whose click
      // clears the selection this drag is carrying. The drag owns that click.
      const swallow = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault() }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, true), 0)
      const o = origin.current
      origin.current = null
      if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) < CLICK_SLOP_PX) {
        // A click on the handle, not a drag: arm, and let the next click pick the target.
        lastPointer.current = { x: e.clientX, y: e.clientY }
        setState((s) => (s.mode === 'dragging' ? { ...s, mode: 'armed', hoverId: null, pointer: null } : s))
        return
      }
      resolveTarget(e.clientX, e.clientY)
    }
    const onCancel = () => setState((s) => settle(s))
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

  // Armed, or the tool waiting for a source: a click on a card's body is ours;
  // every other click passes through. Escape backs out one step at a time.
  const listening = state.mode === 'armed' || (state.mode === 'idle' && state.tool)
  useEffect(() => {
    if (!listening) return
    const onMove = (e: PointerEvent) => { lastPointer.current = { x: e.clientX, y: e.clientY } }
    const onClick = (e: MouseEvent) => {
      const s = ref.current
      lastPointer.current = { x: e.clientX, y: e.clientY }
      const id = cardBodyOf(e.target)
      if (!id) {
        // The strip, a scrollbar, the search box, empty canvas: theirs, not ours.
        // Armed, a stray click only reminds — it never drops the connection.
        const own = e.target instanceof Element && e.target.closest('[data-connect-ui]')
        if (s.mode === 'armed' && !own) setState((x) => ({ ...x, nudge: x.nudge + 1 }))
        return
      }
      e.preventDefault()
      e.stopPropagation()
      if (s.mode === 'idle') {
        // The tool, waiting for a source: this card is it.
        setState((x) => ({ ...settle(x), mode: 'armed', sourceId: id, sourceIds: carriedBy(id, opts.current) }))
        return
      }
      if (s.sourceIds.includes(id)) {
        setState((x) => ({ ...x, nudge: x.nudge + 1 }))
        return
      }
      if (e.metaKey || e.ctrlKey) {
        // Collect several targets — from one source only; a carried selection
        // already links into the one card it is dropped on.
        if (s.sourceIds.length > 1) {
          setState((x) => ({ ...x, nudge: x.nudge + 1 }))
          return
        }
        setState((x) => ({
          ...x, targets: x.targets.includes(id) ? x.targets.filter((t) => t !== id) : [...x.targets, id],
        }))
        return
      }
      if (s.targets.length > 0) {
        // A plain click after collecting finishes the set with this card.
        const all = s.targets.includes(id) ? s.targets : [...s.targets, id]
        if (all.length === 1) { resolveTarget(e.clientX, e.clientY, all[0]); return }
        setState(settle(s))
        opts.current.onMultiTarget?.({ sourceId: s.sourceId!, targets: all, at: { x: e.clientX, y: e.clientY } })
        return
      }
      resolveTarget(e.clientX, e.clientY, id)
    }
    const onKey = (e: KeyboardEvent) => {
      const s = ref.current
      if (e.key === 'Escape') {
        // Ours, one step at a time: the collected targets, then the source,
        // then the tool — before any panel behind the canvas hears it.
        e.stopPropagation()
        if (s.mode === 'armed' && s.targets.length > 0) setState((x) => ({ ...x, targets: [] }))
        else if (s.mode === 'armed') setState((x) => settle(x))
        else setState((x) => ({ ...IDLE, nudge: x.nudge }))
      } else if (e.key === 'Enter' && s.mode === 'armed' && s.targets.length > 0) {
        e.preventDefault()
        e.stopPropagation()
        commitTargets()
      }
    }
    window.addEventListener('pointermove', onMove)
    // Delay binding so the click that armed it (if any) doesn't immediately resolve.
    const t = setTimeout(() => {
      window.addEventListener('click', onClick, { capture: true })
      window.addEventListener('keydown', onKey, { capture: true })
    }, 0)
    return () => {
      clearTimeout(t)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [listening, resolveTarget, commitTargets])

  return { state, beginDrag, armConnect, confirm, cancel, clearTargets, setTool, toggleTool, commitTargets }
}
