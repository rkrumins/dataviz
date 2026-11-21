/**
 * What the AI assistant may ask of the mounted Context View canvas — reveal an entity, locate
 * several, start a trace, run a search, open the Cypher console — and what it is looking at,
 * reachable from the assistant's rail without prop-drilling. The canvas registers its handlers
 * while it is mounted (same pattern as `canvasLayoutBridge`); nothing else registers here.
 *
 * Graph and Hierarchy canvases register nothing: the assistant reaches them through deep links
 * (`/views/{id}?focus=…`, `?trace=…`, `?search=…`), which is also what it falls back to whenever
 * the canvas mounted is not the view an answer is about.
 */
import type { Predicate } from '@/types/search'

/** What the canvas is looking at, as the assistant's question carries it. */
export interface CanvasContext {
  viewId: string
  viewName?: string
  workspaceId?: string
  dataSourceId?: string | null
  /** The entities selected on the canvas, as URNs. */
  selectedUrns: string[]
  /** The entity in focus: the drawer's, or the one selected. */
  focusUrn?: string | null
  focusName?: string
}

export interface CanvasTraceRequest {
  direction?: 'upstream' | 'downstream' | 'both'
  /** Hops to show that way (the walk itself fetches everything). */
  depth?: number
}

export interface CanvasActions {
  /** The view the canvas is showing. */
  viewId: string
  reveal: (urn: string) => Promise<unknown> | void
  locateMany: (urns: string[]) => Promise<unknown> | void
  startTrace: (urns: string[], opts?: CanvasTraceRequest) => void
  /** Load the predicate into Advanced Search, open it, and run it. */
  runSearch: (predicate: Predicate) => void
  /** Open Advanced Search's Cypher tab with `cypher` in the console — never run. */
  openCypher: (cypher: string) => void
  getContext: () => CanvasContext
}

let actions: CanvasActions | null = null
const listeners = new Set<() => void>()
let queued: { viewId: string; run: (a: CanvasActions) => void } | null = null

const notify = () => listeners.forEach((fn) => fn())

/** Register the mounted canvas's handlers; the returned function unregisters them. */
export function registerCanvasActions(a: CanvasActions): () => void {
  actions = a
  notify()
  // Something asked for this view before it was open: do it once the canvas has settled in.
  if (queued?.viewId === a.viewId) {
    const { run } = queued
    queued = null
    setTimeout(() => { if (actions === a) run(a) }, 0)
  }
  return () => {
    if (actions !== a) return
    actions = null
    notify()
  }
}

/** The mounted canvas's handlers, whichever view it shows. */
export function canvasActions(): CanvasActions | null {
  return actions
}

/** The mounted canvas's handlers, only when it shows `viewId`. */
export function canvasActionsFor(viewId: string | null | undefined): CanvasActions | null {
  return viewId && actions?.viewId === viewId ? actions : null
}

/** Told when a canvas registers or leaves (for `useSyncExternalStore`). */
export function subscribeCanvasActions(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * Do `run` on the canvas showing `viewId`: now, when it is mounted (true), or once it registers
 * (false — the caller navigates there). A later request replaces one still waiting.
 */
export function whenCanvasShows(viewId: string, run: (a: CanvasActions) => void): boolean {
  const mounted = canvasActionsFor(viewId)
  if (mounted) {
    run(mounted)
    return true
  }
  queued = { viewId, run }
  return false
}
