/**
 * frame-flow — HOW A CONTAINER'S OWN LINEAGE IS ARRANGED AND ROUTED.
 *
 * A frame draws its children as a vertical LIST while the lineage among
 * them is a left-to-right FLOW, and drawing a flow across a list is what
 * put long diagonals through every card in between (reported live on a
 * GOLD warehouse frame; the straight-line in-frame router T22 R2
 * introduced guarantees the crossing, and the rows' own order —
 * first-drawn, then busiest — guarantees the length).
 *
 * Two pure passes fix the two halves, and neither knows anything about
 * pixels:
 *
 *   `flowRanks`    orders the rows so producers sit above consumers, so
 *                  an internal wire runs ONE way down the stack.
 *   `assignLanes`  gives each internal wire a vertical lane in the
 *                  frame's left gutter, so no wire is ever drawn over a
 *                  card and parallel runs never overlap.
 *
 * THE RULE THIS ESTABLISHES: external lineage is horizontal, internal
 * lineage is vertical. A wire that stays inside a container leaves its
 * producer's left port, drops down a lane, and turns back in at its
 * consumer's left port — arrow pointing the way it always does.
 */

/**
 * Past this many flows inside ONE container, drawing every one of them
 * at once is noise whatever the routing does — a warehouse with forty
 * tables feeding each other is a hairball as a picture and a scan as a
 * list. Past it the wires go quiet and draw only for the row the reader
 * is asking about; the COUNTS stay on the rows and the frame header, so
 * what goes is the ink and never the fact.
 */
export const INFRAME_WIRE_CAP = 12

/** Lanes past this are not worth drawing: the gutter would be wider
 *  than the rows it serves, and a frame that dense is the density
 *  gate's problem (the wires go quiet), not the router's. */
export const MAX_LANES = 5

/** One lane's horizontal share of the gutter. */
export const LANE_W = 9

/** Breathing room between the innermost lane and the rows themselves. */
export const LANE_GAP = 6

/** How wide a frame's left gutter must be to hold `lanes` of them. */
export const gutterWidth = (lanes: number): number =>
    lanes <= 0 ? 0 : Math.min(lanes, MAX_LANES) * LANE_W + LANE_GAP

/** The only thing either pass needs to know about a wire. */
export interface InternalEdgeRef {
    id: string
    source: string
    target: string
}

/**
 * Producers first: a rank per row, where every internal wire runs from a
 * lower rank to a higher one.
 *
 * Longest-path layering (Kahn), which is what makes the ranks TIGHT —
 * a consumer sits one rank below its last producer rather than one
 * below its first, so a wire never skips backwards over a row that
 * feeds it.
 *
 * CYCLES ARE NOT AN ERROR — lineage estates have them, and a layering
 * that threw would take the frame's whole list with it. When the queue
 * stalls, the remaining row that appears EARLIEST in the incoming order
 * is promoted to a source and the walk continues; the choice is
 * therefore a pure function of the order handed in, never of Map
 * iteration or edge insertion. The wires it makes run backwards get an
 * outer lane and the existing cycle badge, not special ranks.
 *
 * Rows with no internal lineage at all rank 0 and keep their incoming
 * relative order — they are not "sources", they are simply not part of
 * this conversation.
 */
export function flowRanks(rows: readonly string[], edges: readonly InternalEdgeRef[]): Map<string, number> {
    const member = new Set(rows)
    const outOf = new Map<string, string[]>()
    const indegree = new Map<string, number>()
    for (const r of rows) { outOf.set(r, []); indegree.set(r, 0) }
    for (const e of edges) {
        if (e.source === e.target) continue
        if (!member.has(e.source) || !member.has(e.target)) continue
        outOf.get(e.source)!.push(e.target)
        indegree.set(e.target, indegree.get(e.target)! + 1)
    }

    const orderOf = new Map(rows.map((r, i) => [r, i]))
    const rank = new Map<string, number>()
    const settled = new Set<string>()
    const pending = new Set(rows)

    /** The frontier, taken in the incoming order so ties resolve the way
     *  the caller already ranked them. */
    const readyNow = (): string[] =>
        [...pending].filter(r => (indegree.get(r) ?? 0) === 0)
            .sort((a, b) => orderOf.get(a)! - orderOf.get(b)!)

    while (pending.size > 0) {
        let ready = readyNow()
        if (ready.length === 0) {
            // A cycle holds every remaining row. Break it at the row the
            // caller put first and carry on — deterministic, and the only
            // alternative is refusing to lay out the frame at all.
            const forced = [...pending].sort((a, b) => orderOf.get(a)! - orderOf.get(b)!)[0]
            indegree.set(forced, 0)
            ready = [forced]
        }
        for (const r of ready) {
            pending.delete(r)
            settled.add(r)
            const own = rank.get(r) ?? 0
            rank.set(r, own)
            for (const next of outOf.get(r) ?? []) {
                // A wire into a row that already has its rank is the BACK
                // EDGE of a cycle — the one this walk broke to get moving.
                // Pushing its target down again would chase the loop
                // forever (and, on a three-row ring, rank the row it
                // started from below the two it feeds).
                if (settled.has(next)) continue
                rank.set(next, Math.max(rank.get(next) ?? 0, own + 1))
                indegree.set(next, Math.max(0, (indegree.get(next) ?? 0) - 1))
            }
        }
    }
    return rank
}

/**
 * Order a frame's rows by flow, keeping the caller's own ranking inside
 * each rank.
 *
 * `rows` arrives already ranked the way the rest of the board ranks
 * cards (first-drawn, then busiest, then alphabetical), and that order
 * is preserved WITHIN a rank — so a row's position only ever moves when
 * new internal lineage genuinely changes which rank it belongs to,
 * which is a real change to what the frame is showing and one the
 * reader's own ⊕ asked for.
 */
export function flowOrder(rows: readonly string[], edges: readonly InternalEdgeRef[]): string[] {
    if (rows.length < 2 || edges.length === 0) return [...rows]
    const rank = flowRanks(rows, edges)
    const orderOf = new Map(rows.map((r, i) => [r, i]))
    return [...rows].sort((a, b) =>
        (rank.get(a) ?? 0) - (rank.get(b) ?? 0)
        || orderOf.get(a)! - orderOf.get(b)!)
}

/**
 * A vertical lane per internal wire, so parallel runs never sit on top
 * of each other.
 *
 * Interval partitioning over each wire's ROW SPAN — the same allocator a
 * git commit graph or a subway map uses. SHORTEST SPANS GET THE INNER
 * LANES: a hop between neighbouring rows hugs the cards it joins, and
 * the wire that runs the length of the frame sits outside everything,
 * which is both prettier and easier to follow than the reverse.
 *
 * A wire whose span cannot fit within `MAX_LANES` gets no lane at all
 * (absent from the returned map) rather than a lane the gutter has no
 * room to draw — its caller falls back to the plain router, and a frame
 * that dense has its wires quieted anyway.
 */
export function assignLanes(
    order: readonly string[],
    edges: readonly InternalEdgeRef[],
): Map<string, number> {
    const indexOf = new Map(order.map((r, i) => [r, i]))
    const spans = edges
        .map(e => {
            const a = indexOf.get(e.source)
            const b = indexOf.get(e.target)
            if (a === undefined || b === undefined || a === b) return null
            return { id: e.id, lo: Math.min(a, b), hi: Math.max(a, b) }
        })
        .filter((s): s is { id: string; lo: number; hi: number } => s !== null)
        .sort((x, y) =>
            (x.hi - x.lo) - (y.hi - y.lo)
            || x.lo - y.lo
            || x.id.localeCompare(y.id))

    const occupied: Array<Array<{ lo: number; hi: number }>> = []
    const lane = new Map<string, number>()
    for (const span of spans) {
        let placed = -1
        for (let k = 0; k < occupied.length; k++) {
            if (occupied[k].every(o => o.hi <= span.lo || o.lo >= span.hi)) { placed = k; break }
        }
        if (placed === -1) {
            if (occupied.length >= MAX_LANES) continue   // no room: no lane, no lie
            occupied.push([])
            placed = occupied.length - 1
        }
        occupied[placed].push({ lo: span.lo, hi: span.hi })
        lane.set(span.id, placed)
    }
    return lane
}
