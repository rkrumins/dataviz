/**
 * closure-adapter — the ONLY file that knows the backend closure wire shape
 * for the Lineage Lens. Everything downstream (hooks, view) works with
 * `LensWalkModel` / `lens-subgraph.ts` types instead.
 *
 * Two responsibilities:
 *
 *  • `toLensClosure` converts ONE `/trace/closure` response into a
 *    `LensWalkModel` — exactly the shape `buildLensSubgraph` (lens-subgraph.ts)
 *    consumes.
 *  • `mergeClosures` accumulates a response INTO an existing walk model —
 *    the client-side union that turns a sequence of one-hop server
 *    responses into the whole picture the lens renders. Pure: it never
 *    mutates `model` or `response`, and returns a new model each time.
 *
 * Node shape: `LensWalkNode` is the canvas-ready `LineageNode` (built via
 * the same `toCanvasNode` the rest of the app uses) PLUS the flat
 * `urn`/`displayName`/`entityType` fields `LensNodeLike` needs —
 * `buildLensSubgraph` reads `.urn` directly off each list entry, and the
 * nested `data.urn` alone isn't visible to it. The flat fields are
 * redundant with `data.urn`/`data.label`/`data.type` by design: the lens
 * reads the flat fields structurally, a renderer reads `.data` like any
 * other canvas node.
 *
 * Seam-edge contract: a response's `edges`/`containmentEdges` may
 * reference urns absent from THAT SAME response's `nodes` — urns the
 * client already holds (excluded from re-shipping) whose edge into them
 * still ships, to stitch this step onto the graph the client already has.
 * `mergeClosures` unions nodes and edges independently; once both a seam
 * edge's endpoints have been merged in (which may take a hop or two if a
 * dangling edge is itself part of the accumulation), `buildLensSubgraph`
 * resolves it. Until then it defensively drops it — silently, by design
 * (see lens-subgraph.ts).
 */
import type { GraphNode, TraceV2Result, LensClosureExtras } from '@/providers/GraphDataProvider'
import { toCanvasNode } from '@/lib/canvasNodeMapper'
import type { LineageNode } from '@/store/canvas'
import type {
    LensEdgeLike,
    LensContainmentEdgeLike,
    LensFrontierEntry,
} from './lens-subgraph'

/** A `LineageNode` (the canvas-ready shape `toCanvasNode` produces) plus the
 *  flat `LensNodeLike` fields — see file header. */
export interface LensWalkNode extends LineageNode {
    urn: string
    displayName?: string
    entityType?: string
}

function toLensWalkNode(n: GraphNode): LensWalkNode {
    return {
        ...toCanvasNode(n),
        urn: n.urn,
        displayName: n.displayName,
        entityType: n.entityType,
    }
}

function toLensFrontierEntry(
    f: { urn: string; totalCount?: number | null; nextCursor?: string | null; reason?: 'cut' | 'depth' | null },
): LensFrontierEntry {
    // An older server says nothing about WHY; a cursored entry can only be
    // a paged hub (a cut), a bare one a depth boundary.
    const kind: 'cut' | 'depth' = f.reason ?? (f.nextCursor ? 'cut' : 'depth')
    return {
        urn: f.urn,
        totalCount: f.totalCount ?? null,
        nextCursor: f.nextCursor ?? null,
        kind,
    }
}

/** A model is PARTIAL while something the walk OWES is still out: a seed
 *  cursor, or a frontier entry the budget cut (a hub's cursor included). A
 *  depth boundary is not partiality — it is the next hop. Derived every
 *  merge, never OR-accumulated, so a drained walk reads as complete. */
function isOwed(seedCursor: string | null, up: ReadonlyArray<LensFrontierEntry>, down: ReadonlyArray<LensFrontierEntry>): boolean {
    if (seedCursor !== null) return true
    return [...up, ...down].some(f => f.kind === 'cut' || f.nextCursor !== null)
}

/** The accumulated walk state: the client-side union of every one-hop
 *  closure response fetched so far. Structurally, exactly what
 *  `buildLensSubgraph`'s `LensSubgraphInput` consumes (see lens-subgraph.ts) —
 *  every field concrete (never optional/undefined) so `mergeClosures` never
 *  has to special-case a missing predecessor field. */
export interface LensWalkModel {
    readonly focusUrn: string
    readonly nodes: ReadonlyArray<LensWalkNode>
    /** Raw lineage hops — the ONLY edges rendered as lineage. */
    readonly lineageEdges: ReadonlyArray<LensEdgeLike>
    /** parent→child containment, for nesting only. */
    readonly containmentEdges: ReadonlyArray<LensContainmentEdgeLike>
    readonly upstreamUrns: ReadonlySet<string>
    readonly downstreamUrns: ReadonlySet<string>
    readonly frontierUp: ReadonlyArray<LensFrontierEntry>
    readonly frontierDown: ReadonlyArray<LensFrontierEntry>
    readonly truncated: boolean
    readonly truncationReason: string | null
    /** The initial seed fetch itself was capped, before any walk happened. */
    readonly seedTruncated: boolean
    /** Resume point for the FOCUS's own capped contents ("s:<urn>"), or
     *  null when fully seeded. Advanced only by focus-anchored merges. */
    readonly seedCursor: string | null
}

/** The zero-value walk model a hook starts from before any response has
 *  landed. */
export function emptyWalkModel(focusUrn: string): LensWalkModel {
    return {
        focusUrn,
        nodes: [],
        lineageEdges: [],
        containmentEdges: [],
        upstreamUrns: new Set(),
        downstreamUrns: new Set(),
        frontierUp: [],
        frontierDown: [],
        truncated: false,
        truncationReason: null,
        seedTruncated: false,
        seedCursor: null,
    }
}

/** Convert ONE `/trace/closure` response into a `LensWalkModel`. `focusUrn`
 *  is the lens's overall focus (stable across a whole walk) — NOT
 *  necessarily `res.focus.urn`, which is whatever node this particular
 *  response was anchored on (the focus itself, or a card being extended). */
export function toLensClosure(
    res: TraceV2Result & LensClosureExtras,
    focusUrn: string,
): LensWalkModel {
    const up = res.frontierUp.map(toLensFrontierEntry)
    const down = res.frontierDown.map(toLensFrontierEntry)
    return {
        focusUrn,
        nodes: res.nodes.map(toLensWalkNode),
        lineageEdges: res.edges.map(e => {
            const props = e.properties ?? {}
            const isRollup = String(e.edgeType ?? '').toUpperCase() === 'AGGREGATED'
            const w = props.weight ?? props.count
            return { ...e, kind: isRollup ? 'rollup' as const : 'raw' as const, weight: typeof w === 'number' ? w : null }
        }),
        containmentEdges: res.containmentEdges,
        upstreamUrns: new Set(res.upstreamUrns),
        downstreamUrns: new Set(res.downstreamUrns),
        frontierUp: up,
        frontierDown: down,
        truncated: isOwed(res.seedCursor ?? null, up, down) || isFailure(res.truncationReason),
        truncationReason: (isOwed(res.seedCursor ?? null, up, down) || isFailure(res.truncationReason))
            ? (res.truncationReason ?? 'max_nodes')
            : null,
        seedTruncated: (res.seedCursor ?? null) !== null,
        seedCursor: res.seedCursor ?? null,
    }
}

/** A reason that names a FAILURE (not a budget cut) keeps the model partial
 *  even when nothing is owed on the frontier — the page lost something. */
function isFailure(reason: string | null | undefined): boolean {
    return !!reason && reason !== 'max_nodes'
}

function edgeKey(e: LensEdgeLike): string {
    return e.id ?? `${e.sourceUrn} ${e.targetUrn} ${e.edgeType ?? ''}`
}

/** No `id` on containment (and no `edgeType` either) — a child has exactly
 *  one parent, so the (source, target) pair alone is already a unique key. */
function containmentKey(e: LensContainmentEdgeLike): string {
    return `${e.sourceUrn} ${e.targetUrn}`
}

/** Union `existing` with `incoming`, keyed by urn: delete `rootUrn`'s old
 *  entry first when `clearRoot` (the response is authoritative for it —
 *  its ABSENCE from `incoming` means the walk there is done, clearing the
 *  stored cursor), then upsert every entry `incoming` DOES carry (response
 *  wins). Sorted by urn on the way out so repeated merges of the same
 *  response are byte-for-byte idempotent regardless of prior insertion
 *  order (delete+re-insert would otherwise be able to shuffle position). */
function mergeFrontier(
    existing: ReadonlyArray<LensFrontierEntry>,
    incoming: ReadonlyArray<LensFrontierEntry>,
    clearRoot: boolean,
    rootUrn: string,
    clearRoots: ReadonlyArray<string> = [],
): LensFrontierEntry[] {
    const byUrn = new Map<string, LensFrontierEntry>()
    for (const f of existing) byUrn.set(f.urn, f)
    if (clearRoot) byUrn.delete(rootUrn)
    // A BULK re-seed is authoritative for every anchor it named: the
    // response re-reports the ones still open, so the rest are drained.
    // Without this the union keeps stale entries and the driver re-chases
    // them forever.
    for (const u of clearRoots) byUrn.delete(u)
    for (const f of incoming) byUrn.set(f.urn, f)
    return [...byUrn.values()].sort((a, b) => a.urn.localeCompare(b.urn))
}

/**
 * Accumulate `response` into `model`. Pure and idempotent: merging the same
 * `(response, ctx)` twice deep-equals merging it once, and neither `model`
 * nor `response` is ever mutated.
 *
 * `ctx` names which node/direction `response` is authoritative for — the
 * card the walk just extended (the focus itself, on the very first merge).
 */
export function mergeClosures(
    model: LensWalkModel,
    response: TraceV2Result & LensClosureExtras,
    ctx: {
        rootUrn: string
        direction: 'up' | 'down' | 'both'
        /** Every anchor a bulk re-seed named: their frontier entries are
         *  replaced by what the response re-reports (see `mergeFrontier`). */
        clearFrontierRoots?: ReadonlyArray<string>
        /** Default true. False for a page that speaks for nothing the
         *  model still owes — the COARSE page (Part G): its nodes, cells
         *  and direction sets union in, but its empty frontier clears no
         *  root and its absent cursor overwrites none. Without this a
         *  coarse page landing after the fine page wiped the cursor and
         *  the walk silently stopped short. */
        authoritative?: boolean
    },
): LensWalkModel {
    const authoritative = ctx.authoritative ?? true
    const incoming = toLensClosure(response, model.focusUrn)

    // Nodes: union by urn, LAST write wins — a fresher hydration may carry
    // an updated childCount or other payload change.
    const nodeByUrn = new Map<string, LensWalkNode>()
    for (const n of model.nodes) nodeByUrn.set(n.urn, n)
    for (const n of incoming.nodes) nodeByUrn.set(n.urn, n)

    // Edges: union by id (fallback key when absent). See file header for
    // the seam-edge contract this makes possible.
    const lineageByKey = new Map<string, LensEdgeLike>()
    for (const e of model.lineageEdges) lineageByKey.set(edgeKey(e), e)
    for (const e of incoming.lineageEdges) lineageByKey.set(edgeKey(e), e)

    const containmentByKey = new Map<string, LensContainmentEdgeLike>()
    for (const e of model.containmentEdges) containmentByKey.set(containmentKey(e), e)
    for (const e of incoming.containmentEdges) containmentByKey.set(containmentKey(e), e)

    const upstreamUrns = new Set([...model.upstreamUrns, ...incoming.upstreamUrns])
    const downstreamUrns = new Set([...model.downstreamUrns, ...incoming.downstreamUrns])

    const clearUp = authoritative && (ctx.direction === 'up' || ctx.direction === 'both')
    const clearDown = authoritative && (ctx.direction === 'down' || ctx.direction === 'both')
    const clearRoots = ctx.clearFrontierRoots ?? []

    const frontierUp = mergeFrontier(model.frontierUp, incoming.frontierUp, clearUp, ctx.rootUrn, clearUp ? clearRoots : [])
    const frontierDown = mergeFrontier(model.frontierDown, incoming.frontierDown, clearDown, ctx.rootUrn, clearDown ? clearRoots : [])
    // The focus-contents cursor belongs to FOCUS-anchored responses (the
    // initial fetch and its seed-page continuations): those are
    // authoritative — they advance it, and drain it to null when a page
    // comes back uncapped. A card-anchored extend/page knows nothing about
    // the focus's contents and must not touch it (its OWN seed cursor is
    // followed by the driver, per op — see useLensWalk).
    const seedCursor = authoritative && ctx.rootUrn === model.focusUrn ? incoming.seedCursor : model.seedCursor
    const owed = isOwed(seedCursor, frontierUp, frontierDown)
    const failed = isFailure(incoming.truncationReason)

    return {
        focusUrn: model.focusUrn,
        nodes: [...nodeByUrn.values()],
        lineageEdges: [...lineageByKey.values()],
        containmentEdges: [...containmentByKey.values()],
        upstreamUrns,
        downstreamUrns,
        frontierUp,
        frontierDown,
        truncated: owed || failed,
        truncationReason: failed ? incoming.truncationReason : (owed ? (incoming.truncationReason ?? model.truncationReason ?? 'max_nodes') : null),
        seedTruncated: seedCursor !== null,
        seedCursor,
    }
}
