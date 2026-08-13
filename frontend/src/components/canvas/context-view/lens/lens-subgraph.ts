/**
 * lens-subgraph — turn the Lineage Lens's ACCUMULATED walk (the client-side
 * union of one-hop closure responses) into the nested, hop-annotated
 * structure the lens renders.
 *
 * THE MODEL (the invariant the whole rebuild hinges on):
 *
 *  • LINEAGE edges are the ONLY hops. They are what the graph shows.
 *  • CONTAINMENT is orthogonal: it NESTS participants (leaf → top-most) and is
 *    never rendered as a hop. The backend returns the two in separate lists;
 *    this module keeps them separate.
 *  • Everything is STRUCTURAL, never type-based — `depth` is containment depth
 *    within the walked model and a leaf is simply "no scoped children". That is
 *    what makes it ontology-agnostic: self-nesting (Node ⊃ Node ⊃ Node),
 *    fixed-named (Domain → System → … → Column) and ragged/optional
 *    (Layer → Object → Group? → Attribute) hierarchies all normalize
 *    correctly, with branches legitimately bottoming out at different depths.
 *  • Children are SCOPED to walked participants. A containment edge pointing
 *    outside the model is dropped, so expanding a table with 1000 columns can
 *    only ever reveal the ones actually on the focus's lineage. This is what
 *    makes "bring back the whole world" structurally impossible.
 *
 * ACCUMULATION: the input is the MERGED union of every one-hop response
 * fetched so far, not a single response. A response's seam edges (into
 * urns the client already knew about but had previously excluded) resolve
 * the moment the union happens, with no special-casing here. Because a
 * merge can momentarily see an edge before both its endpoints, every
 * lineage/containment edge with an endpoint absent from `nodes` is
 * defensively DROPPED rather than thrown on — silently, by design, since
 * the accumulation contract makes that case unreachable except mid-merge.
 */

export interface LensNodeLike {
    urn: string
    /** Passed through untouched from the backend node payload, for rendering. */
    displayName?: string
    entityType?: string
}

export interface LensEdgeLike {
    id?: string
    sourceUrn: string
    targetUrn: string
    edgeType?: string
}

/** parent → child */
export interface LensContainmentEdgeLike {
    sourceUrn: string
    targetUrn: string
}

/** A direction's walk frontier for one node: what the server says is left
 *  to fetch beyond the model already in hand. */
export interface LensFrontierEntry {
    urn: string
    /** Edges beyond what's loaded, or null when the server doesn't know. */
    totalCount: number | null
    /** Paging cursor for the rest, or null when there is nothing further. */
    nextCursor: string | null
}

export interface LensSubgraphInput<N extends LensNodeLike = LensNodeLike> {
    focusUrn: string
    nodes: ReadonlyArray<N>
    /** Raw lineage hops — the ONLY edges rendered as lineage. */
    lineageEdges: ReadonlyArray<LensEdgeLike>
    /** parent→child containment. Used ONLY for nesting; never a hop. */
    containmentEdges: ReadonlyArray<LensContainmentEdgeLike>
    upstreamUrns?: ReadonlySet<string> | ReadonlyArray<string>
    downstreamUrns?: ReadonlySet<string> | ReadonlyArray<string>
    /** Per-node "more to fetch" state, upstream and downstream. */
    frontierUp?: ReadonlyArray<LensFrontierEntry>
    frontierDown?: ReadonlyArray<LensFrontierEntry>
    truncated?: boolean
    truncationReason?: string | null
    /** The initial seed fetch itself was capped, before any walk happened. */
    seedTruncated?: boolean
}

export interface LensSubgraphNode<N extends LensNodeLike = LensNodeLike> {
    urn: string
    /** The backend node payload, passed through untouched. */
    node: N
    /** Containment parent WITHIN the model (null for a model root). */
    parent: string | null
    /** Containment children WITHIN the model — the lens-scoped child set. */
    children: string[]
    /** Structural containment depth within the model (roots = 0). */
    depth: number
    /** No scoped children — the finest grain on this branch. */
    isLeaf: boolean
    up: boolean
    down: boolean
    isFocus: boolean
    /** Min lineage-hop distance walking edges FORWARD (sourceUrn->targetUrn)
     *  from hop 0. Null when never reached that way. A diamond/cycle node
     *  reachable from more than one path carries the SHORTEST distance. */
    hopDown: number | null
    /** Min lineage-hop distance walking edges REVERSED from hop 0. Null when
     *  never reached that way. A node can carry both hopUp and hopDown when
     *  it sits on both sides of the focus (a diamond/cycle). */
    hopUp: number | null
    /** Within-model raw-hop count: #edges with targetUrn === this urn. */
    degreeUp: number
    /** Within-model raw-hop count: #edges with sourceUrn === this urn. */
    degreeDown: number
    /** What the server says is left to fetch upstream of this node, or null
     *  when nothing was reported for it. */
    frontierUp: LensFrontierEntry | null
    /** Same, downstream. */
    frontierDown: LensFrontierEntry | null
}

export interface LensSubgraph<N extends LensNodeLike = LensNodeLike> {
    focusUrn: string
    nodes: Map<string, LensSubgraphNode<N>>
    /** Structural depth-0 containers — the top of the focus view. */
    roots: string[]
    /** The only hops. */
    lineageEdges: LensEdgeLike[]
    truncated: boolean
    truncationReason: string | null
    /** The initial seed fetch itself was capped, before any walk happened. */
    seedTruncated: boolean
}

const asSet = (v?: ReadonlySet<string> | ReadonlyArray<string>): ReadonlySet<string> => {
    if (!v) return new Set<string>()
    return Array.isArray(v) ? new Set(v) : (v as ReadonlySet<string>)
}

export function buildLensSubgraph<N extends LensNodeLike>(
    input: LensSubgraphInput<N>,
): LensSubgraph<N> {
    const member = new Map<string, N>()
    for (const node of input.nodes) {
        if (node?.urn) member.set(node.urn, node)
    }

    const parentOf = new Map<string, string>()
    const childrenOf = new Map<string, string[]>()

    for (const ce of input.containmentEdges) {
        const parent = ce?.sourceUrn
        const child = ce?.targetUrn
        if (!parent || !child || parent === child) continue
        // SCOPE: drop any containment edge touching a non-participant, so a
        // scoped child set can only ever contain lineage participants.
        if (!member.has(parent) || !member.has(child)) continue
        if (!parentOf.has(child)) parentOf.set(child, parent)
        const kids = childrenOf.get(parent) ?? []
        if (!kids.includes(child)) kids.push(child)
        childrenOf.set(parent, kids)
    }

    // Structural depth within the model. Memoized, cycle-safe (a containment
    // cycle degrades to depth 0 rather than looping).
    const depthCache = new Map<string, number>()
    const depthOf = (urn: string, guard: Set<string>): number => {
        const cached = depthCache.get(urn)
        if (cached !== undefined) return cached
        if (guard.has(urn)) return 0
        const parent = parentOf.get(urn)
        if (!parent) {
            depthCache.set(urn, 0)
            return 0
        }
        guard.add(urn)
        const d = depthOf(parent, guard) + 1
        depthCache.set(urn, d)
        return d
    }

    // Defensively drop any lineage edge with an endpoint absent from `nodes`.
    // The input is an ACCUMULATION — a merge can momentarily see a seam edge
    // before both its endpoints are unioned in — so this is silent by
    // design rather than thrown: the accumulation contract makes it
    // unreachable except mid-merge.
    const lineageEdges = input.lineageEdges.filter(
        e => e && member.has(e.sourceUrn) && member.has(e.targetUrn),
    )

    const up = asSet(input.upstreamUrns)
    const down = asSet(input.downstreamUrns)

    // Hop 0 = the FOCUS SIDE: the focus plus every member that is a
    // containment descendant of it. A container focus has no lineage edges
    // of its own — only its descendants do — so without seeding the whole
    // subtree, a descendant one containment-level down would wrongly read
    // as hop 1 instead of hop 0.
    const hopSeed = new Set<string>()
    if (member.has(input.focusUrn)) hopSeed.add(input.focusUrn)
    const descStack = [...(childrenOf.get(input.focusUrn) ?? [])]
    while (descStack.length > 0) {
        const urn = descStack.pop()!
        if (hopSeed.has(urn)) continue
        hopSeed.add(urn)
        for (const child of childrenOf.get(urn) ?? []) descStack.push(child)
    }

    // BFS over lineageEdges ONLY (containment is never a hop), one pass per
    // direction, each with its own visited set so a lineage cycle cannot
    // spin either BFS forever. hopDown walks sourceUrn->targetUrn verbatim;
    // hopUp walks it reversed.
    const bfsHops = (forward: boolean): Map<string, number> => {
        const adjacency = new Map<string, string[]>()
        for (const e of lineageEdges) {
            const from = forward ? e.sourceUrn : e.targetUrn
            const to = forward ? e.targetUrn : e.sourceUrn
            const neighbors = adjacency.get(from) ?? []
            neighbors.push(to)
            adjacency.set(from, neighbors)
        }
        const hop = new Map<string, number>()
        const queue: string[] = []
        for (const s of hopSeed) { hop.set(s, 0); queue.push(s) }
        for (let i = 0; i < queue.length; i++) {
            const urn = queue[i]
            const d = hop.get(urn)!
            for (const next of adjacency.get(urn) ?? []) {
                if (hop.has(next)) continue
                hop.set(next, d + 1)
                queue.push(next)
            }
        }
        return hop
    }
    const hopDownOf = bfsHops(true)
    const hopUpOf = bfsHops(false)

    // Degrees: one O(E) pass, raw hops (parallel edges each count).
    const degreeUpOf = new Map<string, number>()
    const degreeDownOf = new Map<string, number>()
    for (const e of lineageEdges) {
        degreeDownOf.set(e.sourceUrn, (degreeDownOf.get(e.sourceUrn) ?? 0) + 1)
        degreeUpOf.set(e.targetUrn, (degreeUpOf.get(e.targetUrn) ?? 0) + 1)
    }

    // Frontier stamping: keyed from the input lists. An entry for an urn
    // outside the model is simply not stamped anywhere — ignored, not thrown.
    const frontierUpOf = new Map<string, LensFrontierEntry>()
    for (const f of input.frontierUp ?? []) {
        if (f && member.has(f.urn)) frontierUpOf.set(f.urn, f)
    }
    const frontierDownOf = new Map<string, LensFrontierEntry>()
    for (const f of input.frontierDown ?? []) {
        if (f && member.has(f.urn)) frontierDownOf.set(f.urn, f)
    }

    const nodes = new Map<string, LensSubgraphNode<N>>()
    const roots: string[] = []

    for (const [urn, node] of member) {
        const parent = parentOf.get(urn) ?? null
        const children = childrenOf.get(urn) ?? []
        if (parent === null) roots.push(urn)
        nodes.set(urn, {
            urn,
            node,
            parent,
            children,
            depth: depthOf(urn, new Set<string>()),
            isLeaf: children.length === 0,
            up: up.has(urn),
            down: down.has(urn),
            isFocus: urn === input.focusUrn,
            hopDown: hopDownOf.get(urn) ?? null,
            hopUp: hopUpOf.get(urn) ?? null,
            degreeUp: degreeUpOf.get(urn) ?? 0,
            degreeDown: degreeDownOf.get(urn) ?? 0,
            frontierUp: frontierUpOf.get(urn) ?? null,
            frontierDown: frontierDownOf.get(urn) ?? null,
        })
    }

    return {
        focusUrn: input.focusUrn,
        nodes,
        roots,
        lineageEdges,
        truncated: input.truncated ?? false,
        truncationReason: input.truncationReason ?? null,
        seedTruncated: input.seedTruncated ?? false,
    }
}

/**
 * The containment ancestors of the focus (excluding the focus itself), so the
 * view can auto-expand down to it — the focus must be visible the moment a
 * walk lands, without the user hunting for it.
 */
export function focusAncestorChain<N extends LensNodeLike>(
    sg: LensSubgraph<N>,
): Set<string> {
    const chain = new Set<string>()
    let cursor = sg.nodes.get(sg.focusUrn)?.parent ?? null
    while (cursor && !chain.has(cursor)) {
        chain.add(cursor)
        cursor = sg.nodes.get(cursor)?.parent ?? null
    }
    return chain
}

/**
 * The visible rows, in nested pre-order: every root, and beneath each expanded
 * node its SCOPED children (recursively).
 *
 * This is the whole "expand can never bring back the world" guarantee, and it
 * is a pure function of (model, expandedNodes) — no fetch. Expanding is a
 * re-projection over data already in hand, so toggling a node cannot pull in
 * anything that isn't a lineage participant, and re-collapsing/re-expanding is
 * free and idempotent.
 */
export function visibleLensNodes<N extends LensNodeLike>(
    sg: LensSubgraph<N>,
    expanded: ReadonlySet<string>,
): string[] {
    const out: string[] = []
    const seen = new Set<string>()

    const walk = (urn: string) => {
        if (seen.has(urn)) return   // containment cycle guard
        seen.add(urn)
        out.push(urn)
        if (!expanded.has(urn)) return
        for (const child of sg.nodes.get(urn)?.children ?? []) walk(child)
    }

    for (const root of sg.roots) walk(root)
    return out
}

/** A lineage hop as actually drawn: between two VISIBLE nodes. */
export interface ProjectedLensEdge {
    /** A currently-visible node. Direction is verbatim from the underlying
     *  raw hop(s) — never canonicalized, so A->B and B->A are distinct. */
    sourceUrn: string
    /** A currently-visible node. */
    targetUrn: string
    /** How many underlying raw hops this line bundles. */
    weight: number
    /** True when this IS the raw hop (both endpoints are visible leaves). */
    isLeafEdge: boolean
    /** The bundle's one shared edge type, or '' when it bundles more than one. */
    edgeTypeNorm: string
}

/**
 * Project the raw leaf lineage hops onto the currently VISIBLE nodes.
 *
 * Each raw hop (a -> b) is drawn between the nearest VISIBLE ancestor of `a`
 * and of `b`, so the SAME model renders as `Domain -> Domain` bundles when
 * collapsed and as `column -> column` when fully expanded — the "level"
 * you're looking at is nothing but how far the tree is open. Hops internal to
 * a collapsed container (both endpoints roll up to the same visible node) are
 * hidden rather than drawn as self-loops. Bundling is keyed by the
 * DIRECTIONAL pair `${s} ${t}` — A->B and B->A are always two bundles, never
 * canonicalized into one.
 *
 * `population` is the walk-model's currently-known member set (or a subset
 * of it): only a hop with BOTH endpoints inside it is drawn at all. A hop
 * reaching outside is what the "+N more" frontier pills count instead — this
 * function only ever draws what's already in hand.
 */
export function projectLensEdges<N extends LensNodeLike>(
    sg: LensSubgraph<N>,
    population: ReadonlySet<string>,
    visible: ReadonlySet<string>,
): ProjectedLensEdge[] {
    const nearestVisible = (urn: string): string | null => {
        let cursor: string | null = urn
        const guard = new Set<string>()
        while (cursor && !guard.has(cursor)) {
            if (visible.has(cursor)) return cursor
            guard.add(cursor)
            cursor = sg.nodes.get(cursor)?.parent ?? null
        }
        return null
    }

    const bundles = new Map<string, ProjectedLensEdge>()
    for (const hop of sg.lineageEdges) {
        if (!population.has(hop.sourceUrn) || !population.has(hop.targetUrn)) continue
        const s = nearestVisible(hop.sourceUrn)
        const t = nearestVisible(hop.targetUrn)
        if (!s || !t || s === t) continue   // internal to a collapsed container
        const hopType = hop.edgeType ?? ''
        const key = `${s} ${t}`
        const existing = bundles.get(key)
        if (existing) {
            existing.weight += 1
            existing.isLeafEdge = false     // more than one hop ⇒ it's a bundle
            if (existing.edgeTypeNorm !== hopType) existing.edgeTypeNorm = ''
        } else {
            bundles.set(key, {
                sourceUrn: s,
                targetUrn: t,
                weight: 1,
                isLeafEdge: s === hop.sourceUrn && t === hop.targetUrn,
                edgeTypeNorm: hopType,
            })
        }
    }
    return [...bundles.values()]
}
