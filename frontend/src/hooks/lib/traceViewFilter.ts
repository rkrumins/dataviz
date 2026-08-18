/**
 * traceViewFilter — the native canvas trace's VIEW-side scope.
 *
 * The walk always fetches the whole flow; this pure filter answers the
 * direction toggles and the hop-depth limits ("2 upstream, 3 downstream")
 * instantly, with no refetch:
 *
 *  - the focus and its own containment subtree ALWAYS show;
 *  - a lineage participant shows iff its direction is on AND its hop
 *    distance is within that direction's depth. A hop = one lineage edge
 *    at whatever grain carries the lineage (the engine's own depth
 *    semantics — user-ratified 2026-08-18);
 *  - containment ancestors show only while they host something visible,
 *    so hiding a direction hides its whole branch, containers included;
 *  - a participant the BFS cannot reach defaults to hop 1 — shown, never
 *    silently dropped by a distance we failed to compute.
 *
 * Distances BFS outward from the focus SUBTREE (the focus plus its
 * containment descendants — lineage lives at the leaves): upstream
 * against edge direction, downstream along it. Cycle-safe by visited
 * sets everywhere.
 */
import type { LensWalkModel } from '@/components/canvas/context-view/lens/closure-adapter'

export interface TraceViewFilterInput {
    model: LensWalkModel
    focusUrn: string
    showUpstream: boolean
    showDownstream: boolean
    /** Max hops to draw; Infinity = the whole walked flow. */
    upstreamDepth: number
    downstreamDepth: number
}

/** BFS hop distances from `seeds` over an adjacency map. Seeds are hop 0;
 *  their direct neighbours hop 1. */
function bfsDistances(
    seeds: ReadonlySet<string>,
    adjacency: ReadonlyMap<string, string[]>,
): Map<string, number> {
    const dist = new Map<string, number>()
    const queue: string[] = []
    for (const s of seeds) {
        dist.set(s, 0)
        queue.push(s)
    }
    for (let i = 0; i < queue.length; i++) {
        const urn = queue[i]!
        const d = dist.get(urn)!
        for (const next of adjacency.get(urn) ?? []) {
            if (dist.has(next)) continue
            dist.set(next, d + 1)
            queue.push(next)
        }
    }
    return dist
}

export function computeTraceVisibleUrns(input: TraceViewFilterInput): Set<string> {
    const { model, focusUrn, showUpstream, showDownstream, upstreamDepth, downstreamDepth } = input

    // Containment maps from the model's own edges.
    const childToParent = new Map<string, string>()
    const parentToChildren = new Map<string, string[]>()
    for (const e of model.containmentEdges) {
        if (!e.sourceUrn || !e.targetUrn) continue
        childToParent.set(e.targetUrn, e.sourceUrn)
        const kids = parentToChildren.get(e.sourceUrn)
        if (kids) kids.push(e.targetUrn)
        else parentToChildren.set(e.sourceUrn, [e.targetUrn])
    }

    // The focus subtree: focus + containment descendants (cycle-safe).
    const focusSubtree = new Set<string>([focusUrn])
    const stack = [focusUrn]
    while (stack.length > 0) {
        const urn = stack.pop()!
        for (const child of parentToChildren.get(urn) ?? []) {
            if (focusSubtree.has(child)) continue
            focusSubtree.add(child)
            stack.push(child)
        }
    }

    // Lineage adjacency, both orientations.
    const forward = new Map<string, string[]>()
    const reverse = new Map<string, string[]>()
    for (const e of model.lineageEdges) {
        const f = forward.get(e.sourceUrn)
        if (f) f.push(e.targetUrn)
        else forward.set(e.sourceUrn, [e.targetUrn])
        const r = reverse.get(e.targetUrn)
        if (r) r.push(e.sourceUrn)
        else reverse.set(e.targetUrn, [e.sourceUrn])
    }
    const upDist = bfsDistances(focusSubtree, reverse)
    const downDist = bfsDistances(focusSubtree, forward)

    // A participant's hop distance: its own BFS distance, else the MIN of
    // its containment descendants' (lineage lives at the leaves — a table
    // in the direction sets is there because of its columns), else hop 1
    // (a truly unreachable orphan is shown, never silently dropped).
    const distOf = (urn: string, dist: ReadonlyMap<string, number>): number => {
        const own = dist.get(urn)
        if (own !== undefined) return own
        let min: number | undefined
        const seen = new Set<string>([urn])
        const walk = [urn]
        while (walk.length > 0) {
            for (const child of parentToChildren.get(walk.pop()!) ?? []) {
                if (seen.has(child)) continue
                seen.add(child)
                walk.push(child)
                const d = dist.get(child)
                if (d !== undefined && (min === undefined || d < min)) min = d
            }
        }
        return min ?? 1
    }

    // Participants that pass their direction's toggle + depth.
    const visible = new Set<string>(focusSubtree)
    const passes = (urn: string): boolean => {
        const isUp = model.upstreamUrns.has(urn)
        const isDown = model.downstreamUrns.has(urn)
        if (isUp && showUpstream && distOf(urn, upDist) <= upstreamDepth) return true
        if (isDown && showDownstream && distOf(urn, downDist) <= downstreamDepth) return true
        return false
    }
    const visibleParticipants: string[] = []
    for (const n of model.nodes) {
        if (visible.has(n.urn)) continue
        if (passes(n.urn)) {
            visible.add(n.urn)
            visibleParticipants.push(n.urn)
        }
    }
    for (const u of [...model.upstreamUrns, ...model.downstreamUrns]) {
        if (visible.has(u)) continue
        if (passes(u)) {
            visible.add(u)
            visibleParticipants.push(u)
        }
    }

    // Ancestors of visible participants — a container shows only while it
    // hosts something visible.
    for (const urn of visibleParticipants) {
        const seen = new Set<string>([urn])
        let cursor = childToParent.get(urn)
        while (cursor && !seen.has(cursor)) {
            seen.add(cursor)
            visible.add(cursor)
            cursor = childToParent.get(cursor)
        }
    }
    // The focus's own ancestors always show (they host the focus).
    {
        const seen = new Set<string>([focusUrn])
        let cursor = childToParent.get(focusUrn)
        while (cursor && !seen.has(cursor)) {
            seen.add(cursor)
            visible.add(cursor)
            cursor = childToParent.get(cursor)
        }
    }

    return visible
}
