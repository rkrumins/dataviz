/**
 * useConnectGesture — the DOM pointer mechanics for the connect flow, feeding
 * the authoring controller. Split out from the controller so the state machine
 * stays pure/testable and this hook owns only the window listeners.
 *
 *   • drag  — while in `connect` via 'drag', pointermove updates the rubber-band
 *     pointer (+ the hovered target for live validity), pointerup resolves.
 *   • armed — the next click resolves the target; Escape cancels.
 *
 * Node ids are resolved from the DOM via the `layer-node-*` ids the cards carry
 * (same convention as the legacy useEdgeConnect).
 */
import { useEffect } from 'react'
import type { GraphAuthoringController } from './useGraphAuthoring'

/** Resolve a viewport point to the node id under it (or null). */
export function nodeIdAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)
  const card = el?.closest('[id^="layer-node-"]') as HTMLElement | null
  return card ? card.id.slice('layer-node-'.length) : null
}

export function useConnectGesture(controller: GraphAuthoringController): void {
  const { mode, updatePointer, resolveTarget, cancel } = controller
  const connectVia = mode.kind === 'connect' ? mode.via : null

  // Drag: follow the pointer (and hovered target), resolve on release.
  useEffect(() => {
    if (connectVia !== 'drag') return
    const onMove = (e: PointerEvent) => {
      const hover = nodeIdAt(e.clientX, e.clientY)
      updatePointer({ x: e.clientX, y: e.clientY }, hover)
    }
    const onUp = (e: PointerEvent) => {
      resolveTarget(nodeIdAt(e.clientX, e.clientY), { x: e.clientX, y: e.clientY })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [connectVia, updatePointer, resolveTarget])

  // Armed: next click picks the target; Escape cancels.
  useEffect(() => {
    if (connectVia !== 'armed') return
    const onClick = (e: MouseEvent) => {
      e.preventDefault()
      resolveTarget(nodeIdAt(e.clientX, e.clientY), { x: e.clientX, y: e.clientY })
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel() }
    // Delay binding so the click/keypress that armed it doesn't immediately resolve.
    const t = window.setTimeout(() => {
      window.addEventListener('click', onClick, { once: true, capture: true })
      window.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [connectVia, resolveTarget, cancel])
}
