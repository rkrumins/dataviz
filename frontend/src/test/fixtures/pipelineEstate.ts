/**
 * A synthetic estate big enough to make a WALK a walk, plus a fake server
 * that answers the real closure contract over it.
 *
 * This exists for the PARITY GATE. The canvas trace paints coarse and then
 * walks the rest in the background; the Lens's Full Flow walks from the
 * start. The ruling is that both must end up holding the same lineage — so
 * the only way to test it is to give both engines the same graph, through the
 * same wire contract, and compare what they finish with. A hand-written
 * response fixture cannot do that: it would agree with whichever driver it
 * was written for.
 *
 * The estate is a pipeline: `ROOT ⊃ obj_k ⊃ atr_k_j`, with raw flow from
 * every attribute to two attributes one level down, so the reachable set fans
 * out instead of being a single chain. Lineage lives ONLY on the attributes —
 * the objects merely host it — which is the shape that makes a container's
 * chevron and a coarse walk's fallback meaningful.
 *
 * The server implements the parts of `/trace/closure` both engines exercise:
 * seeds resolved down to the lineage-bearing descendants, a bounded page that
 * reports what it did not finish as a frontier, ancestor chains always, and
 * the `grain:'coarse'` shape. It deliberately does NOT implement hub cursors:
 * frontier entries here are depth boundaries, which is what makes both
 * engines re-root on them rather than page.
 */
import type { TraceV2Result, LensClosureExtras, GraphNode } from '@/providers/GraphDataProvider'

export interface PipelineGraph {
    nodes: Map<string, GraphNode>
    parent: Map<string, string>
    children: Map<string, string[]>
    /** Raw flows; the index IS the edge id, as in the real graph. */
    flows: Array<readonly [string, string]>
    /** A leaf attribute in the middle, with flow on both sides of it. */
    focus: string
}

export function pipelineGraph(levels = 50, width = 60): PipelineGraph {
    const nodes = new Map<string, GraphNode>()
    const parent = new Map<string, string>()
    const children = new Map<string, string[]>()
    const flows: Array<readonly [string, string]> = []

    const add = (urn: string, entityType: string, childCount: number, p?: string) => {
        nodes.set(urn, { urn, displayName: urn, entityType, properties: {}, childCount } as unknown as GraphNode)
        if (p) {
            parent.set(urn, p)
            children.set(p, [...(children.get(p) ?? []), urn])
        }
    }

    add('ROOT', 'Roots', levels)
    for (let k = 0; k < levels; k++) {
        add(`obj_${k}`, 'object', width, 'ROOT')
        for (let j = 0; j < width; j++) add(`atr_${k}_${j}`, 'attribute', 0, `obj_${k}`)
    }
    // Three targets, one of them a long stride, so the reachable set SATURATES
    // the width within a few levels instead of widening by one column a hop.
    // That is what makes the walk thousands of nodes rather than hundreds —
    // and a walk that fits in one response tests nothing.
    const stride = Math.max(2, Math.floor(width / 4) + 1)
    for (let k = 0; k < levels - 1; k++) {
        for (let j = 0; j < width; j++) {
            flows.push([`atr_${k}_${j}`, `atr_${k + 1}_${j}`] as const)
            flows.push([`atr_${k}_${j}`, `atr_${k + 1}_${(j + 1) % width}`] as const)
            flows.push([`atr_${k}_${j}`, `atr_${k + 1}_${(j + stride) % width}`] as const)
        }
    }
    return { nodes, parent, children, flows, focus: `atr_${Math.floor(levels / 2)}_0` }
}

/**
 * The TRUE closure of `focus`, computed straight off the graph — the answer
 * both engines must arrive at, independent of either of them.
 *
 * Directional, exactly as a lineage closure is: what feeds the focus and
 * what the focus feeds, transitively, plus the containment ancestors that
 * place them. A node reached upstream is not walked downstream again; that is
 * the closure's own rule, not an engine's shortcut.
 */
export function trueClosure(g: PipelineGraph): Set<string> {
    const out = new Set<string>([g.focus])
    const walk = (dir: 'up' | 'down') => {
        let ring = [g.focus]
        const seen = new Set<string>([g.focus])
        while (ring.length > 0) {
            const next: string[] = []
            for (const f of ring) {
                for (const [s, t] of g.flows) {
                    const other = dir === 'up' ? (t === f ? s : null) : (s === f ? t : null)
                    if (!other || seen.has(other)) continue
                    seen.add(other)
                    out.add(other)
                    next.push(other)
                }
            }
            ring = next
        }
    }
    walk('up')
    walk('down')
    for (const u of [...out]) {
        let cursor = g.parent.get(u)
        while (cursor && !out.has(cursor)) { out.add(cursor); cursor = g.parent.get(cursor) }
    }
    return out
}

interface ClosureRequestish {
    urn: string
    direction?: string
    upstreamDepth?: number
    downstreamDepth?: number
    seedUrns?: string[]
    excludeUrns?: string[]
    grain?: string
    drill?: boolean
}

/**
 * Answer one closure request over `g`.
 *
 * `page` bounds how many NEW nodes one response may carry; whatever the walk
 * had not expanded when it stopped comes back as a frontier entry, which is
 * exactly what both engines follow.
 */
export function fineWalkServer(g: PipelineGraph, page = 1000) {
    const outOf = new Map<string, number[]>()
    const inTo = new Map<string, number[]>()
    g.flows.forEach(([s, t], i) => {
        outOf.set(s, [...(outOf.get(s) ?? []), i])
        inTo.set(t, [...(inTo.get(t) ?? []), i])
    })
    const touches = (urn: string) => (outOf.get(urn)?.length ?? 0) + (inTo.get(urn)?.length ?? 0) > 0
    const descendants = (urn: string): string[] => {
        const out: string[] = []
        const stack = [...(g.children.get(urn) ?? [])]
        while (stack.length > 0) {
            const u = stack.pop()!
            out.push(u)
            stack.push(...(g.children.get(u) ?? []))
        }
        return out
    }
    /** Lineage lives at the leaves: a container seed resolves to the
     *  descendants that actually carry flow — the server-side rule both
     *  engines rely on when they re-root on a container. */
    const resolveSeeds = (urns: string[]): string[] => {
        const out = new Set<string>()
        for (const u of urns) {
            if (touches(u)) out.add(u)
            for (const d of descendants(u)) if (touches(d)) out.add(d)
        }
        return [...out]
    }
    const chainOf = (urn: string): string[] => {
        const out: string[] = []
        let cursor = g.parent.get(urn)
        while (cursor && !out.includes(cursor)) { out.push(cursor); cursor = g.parent.get(cursor) }
        return out
    }

    return (req: ClosureRequestish): TraceV2Result & LensClosureExtras => {
        const wantUp = (req.upstreamDepth ?? 1) > 0
        const wantDown = (req.downstreamDepth ?? 1) > 0
        const maxHops = Math.max(req.upstreamDepth ?? 0, req.downstreamDepth ?? 0)

        const seeds = resolveSeeds(req.seedUrns?.length ? req.seedUrns : [req.urn])
        const edges = new Map<number, readonly [string, string]>()
        // EXCLUDES ARE PRE-VISITED, exactly as the real walk treats them: a
        // node the client already holds is never re-shipped and never filed as
        // a frontier — but an EDGE into one still ships, which is the seam
        // that stitches this step onto what the client has. (It is also what
        // makes a walk terminate: without it the server keeps naming rings the
        // client already drained.)
        // VISITED vs DISCOVERED, kept apart exactly as the real walk keeps
        // them: excludes are pre-visited so they are never re-shipped and
        // never re-filed as a frontier, but they do NOT count against the
        // page — conflating the two starves the walk at exactly `page` nodes,
        // because every later request arrives already "full".
        const visited = new Set<string>([...seeds, ...(req.excludeUrns ?? [])])
        const discovered = new Set<string>(seeds)
        const up = new Set<string>()
        const down = new Set<string>()
        const frontierUp = new Set<string>()
        const frontierDown = new Set<string>()

        let ringUp = wantUp ? [...seeds] : []
        let ringDown = wantDown ? [...seeds] : []
        const hops = req.grain === 'coarse' || req.drill ? 1 : maxHops

        for (let hop = 1; hop <= hops; hop++) {
            const capped = discovered.size >= page
            if (capped) {
                for (const u of ringUp) frontierUp.add(u)
                for (const u of ringDown) frontierDown.add(u)
                break
            }
            const step = (ring: string[], dir: 'up' | 'down'): string[] => {
                const next: string[] = []
                for (const f of ring) {
                    const ids = dir === 'up' ? (inTo.get(f) ?? []) : (outOf.get(f) ?? [])
                    for (const id of ids) {
                        const [s, t] = g.flows[id]
                        edges.set(id, g.flows[id])
                        const other = dir === 'up' ? s : t
                        if (visited.has(other)) continue
                        if (discovered.size >= page) {
                            // The budget cut this ring short; the NEAR end is
                            // what still has more to give.
                            ;(dir === 'up' ? frontierUp : frontierDown).add(f)
                            continue
                        }
                        visited.add(other)
                        discovered.add(other)
                        ;(dir === 'up' ? up : down).add(other)
                        next.push(other)
                    }
                }
                return next
            }
            const nextUp = hop <= (req.upstreamDepth ?? 0) ? step(ringUp, 'up') : []
            const nextDown = hop <= (req.downstreamDepth ?? 0) ? step(ringDown, 'down') : []
            ringUp = nextUp
            ringDown = nextDown
            if (ringUp.length === 0 && ringDown.length === 0) break
        }
        // Depth exhaustion: whatever was still growing is the boundary.
        for (const u of ringUp) frontierUp.add(u)
        for (const u of ringDown) frontierDown.add(u)

        // COARSE also ships the focus's lineage-carrying direct children; in
        // this estate the focus is a leaf, so that set is empty and the shape
        // reduces to "the focus, its chain, its hop-1 partners, their chains".
        const ship = new Set<string>([req.urn, ...discovered])
        for (const u of [...ship]) for (const a of chainOf(u)) ship.add(a)

        return {
            focus: { urn: req.urn, level: 0, entityType: g.nodes.get(req.urn)?.entityType ?? '' },
            nodes: [...ship].map(u => g.nodes.get(u)).filter(Boolean) as GraphNode[],
            edges: [...edges.entries()].map(([id, [s, t]]) => ({
                id: `e${id}`, sourceUrn: s, targetUrn: t, edgeType: 'FLOWS', properties: {},
            })),
            containmentEdges: [...ship]
                .filter(u => ship.has(g.parent.get(u) ?? ''))
                .map(u => ({
                    id: `c:${g.parent.get(u)}>${u}`,
                    sourceUrn: g.parent.get(u)!, targetUrn: u, edgeType: 'HAS',
                })),
            upstreamUrns: up,
            downstreamUrns: down,
            effectiveLevel: 0, isInherited: false, inheritedFromUrn: null,
            truncated: false, truncationReason: null,
            frontierUp: [...frontierUp].map(urn => ({ urn, totalCount: null, nextCursor: null })),
            frontierDown: [...frontierDown].map(urn => ({ urn, totalCount: null, nextCursor: null })),
            seedTruncated: false, seedCursor: null,
        } as unknown as TraceV2Result & LensClosureExtras
    }
}
