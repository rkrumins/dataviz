/**
 * "Show on canvas" from outside the canvas (a question's "Show on canvas" in the drawer): the
 * mounted canvas registers how it reveals a node, and anything can ask it to. Each canvas reveals
 * its own way — the Graph canvas pans to the node, the Context view scrolls its virtualised row
 * into view, the Hierarchy opens the node's path and scrolls to it — opening collapsed ancestors
 * (and loading them, where the canvas can) first.
 */
import { useEffect, useRef } from 'react'

export type RevealNode = (nodeId: string) => unknown

let reveal: RevealNode | null = null

/** Register the mounted canvas's reveal; the returned function unregisters it. */
export function registerCanvasReveal(fn: RevealNode): () => void {
    reveal = fn
    return () => { if (reveal === fn) reveal = null }
}

/** Reveal the node on whichever canvas is mounted. False when none is. */
export function revealNodeOnCanvas(nodeId: string): boolean {
    if (!reveal) return false
    Promise.resolve(reveal(nodeId)).catch((err) => console.warn('[canvasReveal] reveal failed for', nodeId, err))
    return true
}

/** For a canvas: `fn` is its reveal while it is mounted (always the latest `fn`). */
export function useCanvasReveal(fn: RevealNode): void {
    const latest = useRef(fn)
    latest.current = fn
    useEffect(() => registerCanvasReveal((id) => latest.current(id)), [])
}
