/**
 * focus-layout — the Lineage Lens's layout engine.
 *
 * Pure: `(walk subgraph + view state) → FocusGraph`. No React, no fetch,
 * no store. The one place a lens picture is built.
 *
 * The five stages, in order, each a pure function of the one before:
 *
 *  1. POPULATION — which entities are in the picture at all. Starts as
 *     the focus, everything inside it, and the containers above it; each
 *     revealed page then admits the next weight-ranked GROUPS of
 *     neighbours. A group is one top-most container of new neighbours, so
 *     one page is at most REVEAL_PAGE new top-level cards — never a card
 *     dump, whatever the fan-out.
 *  2. ANSWER GRAIN — how far the containment tree opens by itself. A
 *     PASS-THROUGH level (exactly one lineage-relevant child) is chrome,
 *     not an answer, so it opens automatically; the first level that
 *     BRANCHES is where the answer lives, and that is where the automatic
 *     opening stops. `Finance ⊃ RiskApp ⊃ PROD ⊃ CURATED ⊃ RISK_DB` opens
 *     itself down to RISK_DB and says "3 on this lineage · of 12".
 *  3. VISIBILITY — a member is its own card only when every containment
 *     ancestor is open; otherwise its nearest open ancestor stands for it,
 *     and `projectLensEdges` accrues its hops onto that card. "Which
 *     level am I looking at" is nothing but how far the tree is open.
 *  4. CARDS — one card per entity, frames nesting to N levels, and the ⊕
 *     pill in exactly one of three states (reveal what's in hand / extend
 *     the walk / page a partial adjacency) or absent when drained.
 *  5. GEOMETRY — signed hop distance is the column; `layoutBands`
 *     stacks and sizes, deepest frame first.
 *
 * HONESTY RULES, contracts of the lens rather than of an implementation:
 * the text filter DIMS and never removes; the type chips remove but
 * report what they removed; a cap states its exact remainder; a dead end
 * is a claim about the data source and is only ever made once the walk
 * says 'done'.
 */
import type { LineageNode } from '@/store/canvas'
import {
    boundaryFrontierFilter,
    focusAncestorChain,
    projectLensEdges,
    visibleLensNodes,
    type LensSubgraph,
    type LensSubgraphNode,
    type ProjectedLensEdge,
} from './lens-subgraph'
import type { LensWalkNode } from './closure-adapter'
import {
    labelOf,
    layoutBands,
    portFraction,
    rowHeight,
    ANCESTRY_CAP,
    DENSITY_PORTS,
    labelFitsRun,
    CARD_H,
    CARD_W,
    CHILD_ROW_H,
    DIVIDER_ROW_H,
    FOCAL_H,
    FRAME_WINDOW,
    FRAME_WINDOW_ALL,
    NO_FRAME_ROWS,
    UNRESOLVED_TYPE,
    type FocusCard,
    type FocusEdge,
    type FocusGraph,
    type FocusPill,
    type FrameRowRef,
} from './focus-cards'

/** Upstream ('in') and downstream ('out') — the lens's own words. The
 *  walk HOOK speaks 'up'/'down'; `walkStatusKey` is the one place that
 *  translates. */
export type LensDir = 'in' | 'out'

/** New top-level cards one ⊕ click reveals.
 *
 *  Counted in GROUPS, not entities: a group is one root-most container,
 *  so twelve groups is twelve cards however many leaves nest inside them.
 *  Sized to the viewport — a card is ~74px, so twelve fill a ~950px lens
 *  body. */
export const REVEAL_PAGE = 12

/** The layout's own key for "this card, this direction". One namespace
 *  for reveal pages, pills and expand keys. */
export const revealKey = (dir: LensDir, urn: string): string => `${dir}:${urn}`

/** The box a badge occupies — two labels closer than this overlap into
 *  an unreadable smudge, so the second one is not drawn. (How LONG a run
 *  must be to carry one at all is `LABEL_MIN_RUN`, shared with the view,
 *  which re-checks it against the wire it actually draws.) */
const LABEL_W = 56
const LABEL_H = 22

/** The same question in `useLensWalk`'s words, for reading its per-pill
 *  `extendStatus`. The hook keys on up/down; the layout keys on in/out;
 *  this is the ONLY translation between them, so a mismatch is one
 *  function rather than a scatter of string literals. */
export const walkStatusKey = (dir: LensDir, urn: string): string =>
    `${dir === 'in' ? 'up' : 'down'}:${urn}`

const splitKey = (key: string): { dir: LensDir; urn: string } | null => {
    const cut = key.indexOf(':')
    if (cut < 0) return null
    const dir = key.slice(0, cut)
    if (dir !== 'in' && dir !== 'out') return null
    return { dir, urn: key.slice(cut + 1) }
}

/**
 * Everything the user has done to the picture. Deliberately all plain
 * sets and maps of urns: the layout is a pure re-projection over the walk
 * model, so any state here can be serialized into a share link and
 * replayed without a fetch.
 */
export interface LensViewState {
    selection: string | null
    /** `${'in'|'out'}:${urn}` → pages revealed (1..n). */
    revealed: ReadonlyMap<string, number>
    expandedContainment: ReadonlySet<string>
    /** Exceptions UNDER the auto-opened spines — an open the user shut. */
    collapsedContainment: ReadonlySet<string>
    /** Frames flipped from "only what connects" to "everything inside". */
    frameShowAll: ReadonlySet<string>
    /** Containment levels this view has already drawn THROUGH — chrome
     *  over the answer rather than geometry.
     *
     *  Grow-only, and fed back from `FocusGraph.walkedThrough`, because
     *  the grain test reads the population and the population only ever
     *  grows: a table walked through while it had one connected column
     *  would become a card of its own the moment a second arrived, and
     *  the column card already on the board would vanish inside it.
     *  Nothing already drawn may be taken away by a walk growing. Reset
     *  with the rest of this state when the focus changes. */
    walkedThrough: ReadonlySet<string>
    /** Where each already-drawn entity SITS, by the order it was first
     *  drawn in. Grow-only, and fed back from `FocusGraph.drawnRank` the
     *  same way `walkedThrough` is.
     *
     *  Rank is computed from weight, and weight grows as the walk does —
     *  so without this a merge re-ordered cards that were already on the
     *  board, under the pointer of the user whose click caused the merge
     *  (reported live: SILVER and INTERMEDIATE_T2 swapping places). A
     *  drawn card holds its position for this view state's lifetime;
     *  arrivals append; weight updates change badges, never positions. */
    drawnRank: ReadonlyMap<string, number>
    frameQueries: ReadonlyMap<string, string>
    /** Per frame: the first row its scroll window is resting on (0-based
     *  row index), clamped by the layout to what has actually loaded. */
    frameOffsets: ReadonlyMap<string, number>
}

/** One entity's roster — "what is really in here", connected or not.
 *  Structurally `useLensChildren`'s `LensChildrenResult`; declared here so
 *  the layout stays a pure module with no hook dependency. */
export interface LensRoster {
    children: ReadonlyArray<LineageNode>
    hasMore: boolean
    total: number | null
    query?: string
}

export type LensFetchStatus = 'loading' | 'done' | 'error' | 'unsupported'

/** The header's direction preset. VIEW-SIDE only: the fetch always asks
 *  for 'both' directions (cache-friendly, instant toggling), and the
 *  walk's population is never touched — a preset just decides what
 *  `buildFocusLayout` DRAWS. 'in' = "Root cause" (upstream only), 'out'
 *  = "Impact" (downstream only). */
export type LensDirectionFilter = 'both' | LensDir

export interface FocusLayoutInput {
    sg: LensSubgraph<LensWalkNode>
    view: LensViewState
    query: string
    hiddenTypes: ReadonlySet<string>
    /** Per-pill in-flight state, keyed as `useLensWalk` keys it — see
     *  `walkStatusKey`. */
    extendStatus: ReadonlyMap<string, 'loading' | 'error'>
    childrenAll: ReadonlyMap<string, LensRoster>
    childrenAllStatus: ReadonlyMap<string, LensFetchStatus>
    /** The walk model's own fetch state. A dead end is never claimed
     *  while this is anything but 'done'. */
    walkStatus: LensFetchStatus
    /** Suppress one side's bands/pills/edges. Presentation only — the
     *  population this is computed FROM never shrinks, so every count and
     *  pill remainder stays true when the user toggles back. Defaults to
     *  'both' (nothing suppressed). */
    directionFilter?: LensDirectionFilter
}

/**
 * Where a walk starts: one page of neighbours in each direction, and the
 * containment spine down to the focus already open, so the focus is on
 * the board the moment the walk lands rather than buried inside a
 * container the user has to go hunting for.
 */
export function initialLensViewState(sg: LensSubgraph<LensWalkNode>): LensViewState {
    return {
        selection: null,
        revealed: new Map([
            [revealKey('in', sg.focusUrn), 1],
            [revealKey('out', sg.focusUrn), 1],
        ]),
        expandedContainment: new Set([...focusAncestorChain(sg), sg.focusUrn]),
        collapsedContainment: new Set(),
        frameShowAll: new Set(),
        walkedThrough: new Set(),
        drawnRank: new Map(),
        frameQueries: new Map(),
        frameOffsets: new Map(),
    }
}

const EMPTY_STRINGS: string[] = []

/** One reveal group: a root-most container of not-yet-shown neighbours,
 *  and the raw hops that reach into it. */
interface RevealGroup {
    root: string
    weight: number
    members: string[]
    /** Hops per member. A group is ranked by its WHOLE weight (frozen, so
     *  paging cannot re-order the board), but a pill has to say what is
     *  still OUT there — and once part of a group is drawn, the rest of it
     *  is worth only the hops reaching the members that are not. */
    memberWeight: ReadonlyMap<string, number>
}

export function buildFocusLayout(input: FocusLayoutInput): FocusGraph {
    const {
        sg, view, query, hiddenTypes, extendStatus,
        childrenAll, childrenAllStatus, walkStatus,
        directionFilter = 'both',
    } = input
    const model = sg.nodes

    // ── structural helpers over the containment tree ──────────────────
    // Every walk is guarded: `buildLensSubgraph` degrades a containment
    // cycle to depth 0 rather than throwing, so the tree it hands over
    // can still contain one.

    const ancestorCache = new Map<string, string[]>()
    /**
     * Containment ancestors, ROOT-FIRST. WHOLE chain, cycle-guarded.
     *
     * This is a STRUCTURAL walk, not the provenance ribbon: the
     * population is seeded from it (`admit`), `rootOf` reads its head,
     * and the focus-ancestor set is built from it. It used to stop at
     * ANCESTRY_CAP — a DISPLAY constant for how many crumbs a card
     * prints — and six levels down that quietly broke the one invariant
     * the rest of this file leans on.
     *
     * REPORTED LIVE (blank board, 2026-08-14): past six ancestors the
     * population no longer contained the model's own root, so the root
     * was filtered out of the visible order, so the pass that collects
     * top-level units — which starts at nodes whose parent is null —
     * never entered the focus's branch at all. The focal card, its
     * contains-stack and every wire that lands on it went with it; with
     * nothing else outside the chain, the board came out EMPTY.
     *
     * The cap still applies where it was always meant to: `emit` slices
     * the ribbon it prints.
     */
    const ancestorsOf = (urn: string): string[] => {
        const hit = ancestorCache.get(urn)
        if (hit) return hit
        const out: string[] = []
        const seen = new Set<string>([urn])
        let cursor = model.get(urn)?.parent ?? null
        while (cursor && !seen.has(cursor)) {
            seen.add(cursor)
            out.push(cursor)
            cursor = model.get(cursor)?.parent ?? null
        }
        out.reverse()
        ancestorCache.set(urn, out)
        return out
    }
    const rootOf = (urn: string): string => ancestorsOf(urn)[0] ?? urn

    const subtreeCache = new Map<string, Set<string>>()
    /** The entity plus every containment descendant IN THE MODEL. The
     *  model's children are already scoped to walk participants, so this
     *  can never reach outside the lineage. */
    const subtreeOf = (urn: string): Set<string> => {
        const hit = subtreeCache.get(urn)
        if (hit) return hit
        const out = new Set<string>()
        const stack = [urn]
        while (stack.length > 0) {
            const next = stack.pop()!
            if (out.has(next) || !model.has(next)) continue
            out.add(next)
            for (const child of model.get(next)!.children) stack.push(child)
        }
        subtreeCache.set(urn, out)
        return out
    }

    const nodeOf = (urn: string): LensSubgraphNode<LensWalkNode> | undefined => model.get(urn)
    const dataOf = (urn: string): Record<string, unknown> =>
        (nodeOf(urn)?.node?.data as Record<string, unknown> | undefined) ?? {}
    const labelFor = (urn: string): string => labelOf(urn, nodeOf(urn)?.node)
    const typeFor = (urn: string): string =>
        (dataOf(urn).type as string) ?? nodeOf(urn)?.node?.entityType ?? UNRESOLVED_TYPE

    // ── 1. POPULATION ────────────────────────────────────────────────

    const population = new Set<string>()
    /** Admit an entity AND its containment ancestors, so the population
     *  is always ancestor-closed — every card can be nested. */
    const admit = (urn: string): boolean => {
        if (!model.has(urn) || population.has(urn)) return false
        population.add(urn)
        for (const a of ancestorsOf(urn)) population.add(a)
        return true
    }
    for (const urn of subtreeOf(sg.focusUrn)) admit(urn)

    // The ranking baseline. Frozen BEFORE any reveal is applied: a group's
    // RANK must not depend on which pages happen to be open, or paging
    // would re-order the cards already on the board.
    //
    // Freezing the rank is only half of it. The other half is how a page
    // is SPENT — see the admission loop below, which charges a page only
    // for groups it actually introduces. Rank is frozen; budget is not.
    const seed = new Set(population)

    const groupCache = new Map<string, RevealGroup[]>()
    /**
     * Groups of not-yet-shown neighbours reachable from `near`, ranked.
     * Weight is raw hops — the wire the reveal would draw.
     *
     * ONE set, asked FROM and tested as INTERNAL: the card's whole
     * subtree. The pill and the click must agree exactly — the badge is a
     * promise about what one click will draw, so a set the badge did not
     * count is a card that appears unannounced, and a set the click will
     * not admit is a number that never arrives. (They used to differ: the
     * pill asked from what a card VISUALLY STANDS FOR and the click acted
     * on the subtree, which is a superset the moment a frame is open and
     * its rows own themselves. An open frame's ⊕ then spent its page on
     * its rows' neighbours — cards the badge never counted, and, when
     * twelve of them outranked a just-fetched cohort, instead of it.)
     */
    const groupsFrom = (
        dir: LensDir,
        subtree: ReadonlySet<string>,
        cacheKey: string,
    ): RevealGroup[] => {
        const hit = groupCache.get(cacheKey)
        if (hit) return hit
        const byRoot = new Map<string, { weight: number; members: Map<string, number> }>()
        for (const hop of sg.lineageEdges) {
            const from = dir === 'in' ? hop.targetUrn : hop.sourceUrn
            const far = dir === 'in' ? hop.sourceUrn : hop.targetUrn
            if (!subtree.has(from) || subtree.has(far) || seed.has(far)) continue
            const root = rootOf(far)
            const group = byRoot.get(root) ?? { weight: 0, members: new Map<string, number>() }
            group.weight += 1
            group.members.set(far, (group.members.get(far) ?? 0) + 1)
            byRoot.set(root, group)
        }
        const ranked = [...byRoot.entries()]
            .map(([root, g]) => ({
                root,
                weight: g.weight,
                members: [...g.members.keys()].sort(),
                memberWeight: g.members,
            }))
            .sort((a, b) =>
                b.weight - a.weight
                || labelFor(a.root).localeCompare(labelFor(b.root))
                || a.root.localeCompare(b.root))
        groupCache.set(cacheKey, ranked)
        return ranked
    }
    /** What a REVEAL CLICK on this card admits — and, because they are the
     *  same call, exactly what its ⊕ counts: everything reachable from its
     *  whole subtree, whatever is currently open. */
    const rankedGroups = (dir: LensDir, urn: string): RevealGroup[] =>
        groupsFrom(dir, subtreeOf(urn), `sub:${dir}:${urn}`)

    const revealedKeys = [...view.revealed.keys()].sort()
    const processed = new Set<string>()
    /**
     * Admission. A key only becomes live once its own card is in the
     * picture (you can reveal under a card another key revealed), so this
     * iterates until no further key comes alive — at most one pass per key.
     *
     * A PAGE IS CHARGED ONLY FOR WHAT IT INTRODUCES. Two cards can rank
     * the same neighbour: twelve sources feeding both `A` and `B` are
     * twelve groups under each. Slicing the raw ranking spent B's whole
     * page on twelve groups A had already put on the board, so B's ⊕ —
     * correctly reading "1 more", its thirteenth, lower-ranked source —
     * did nothing at all when clicked, forever. Skipping an already-shown
     * group for FREE makes a page always worth a page, and makes the
     * remainder a pill reports genuinely reachable.
     *
     * Two shapes were rejected getting here, both worse than the bug:
     *  • filtering the ranking by population and THEN slicing re-filters
     *    on every pass, so pass 2 no longer sees what pass 1 admitted and
     *    spends a fresh twelve — one click drains the entire ranking and
     *    the cap is gone;
     *  • counting the pill against the slice window hides every group
     *    below it: no number, so no pill, so no way to ever reach them.
     *    Silent truncation is the one thing this builder must not do.
     *
     * The trade: because a shared group is paid for by whichever key
     * reaches it first, the final picture depends on the ORDER keys are
     * processed in. That order is the sorted key list, so a given view
     * state always renders identically (and a share link replays exactly)
     * — deterministic, but no longer order-INDEPENDENT, which the
     * previous version of this loop claimed. It stays monotone in the
     * thing that matters: opening a page, or opening another card's page,
     * only ever ADDS. Nothing already on the board can vanish.
     */
    for (let pass = 0; pass < revealedKeys.length + 1; pass++) {
        let progressed = false
        for (const key of revealedKeys) {
            if (processed.has(key)) continue
            const parsed = splitKey(key)
            const pages = view.revealed.get(key) ?? 0
            if (!parsed || pages <= 0 || !population.has(parsed.urn)) continue
            processed.add(key)
            progressed = true
            let budget = pages * REVEAL_PAGE
            for (const group of rankedGroups(parsed.dir, parsed.urn)) {
                if (budget <= 0) break
                const fresh = group.members.filter(m => !population.has(m))
                // Already on the board — this key owes nothing for it.
                if (fresh.length === 0) continue
                budget -= 1
                for (const member of fresh) admit(member)
            }
        }
        if (!progressed) break
    }

    // ── the column a card sits in: its signed hop distance ───────────

    const hopCache = new Map<string, { up: number | null; down: number | null }>()
    /** A card stands for its whole subtree, so it sits at the NEAREST hop
     *  anything inside it reaches. */
    const hopsOf = (urn: string): { up: number | null; down: number | null } => {
        const hit = hopCache.get(urn)
        if (hit) return hit
        let up: number | null = null
        let down: number | null = null
        for (const inside of subtreeOf(urn)) {
            if (!population.has(inside)) continue
            const n = model.get(inside)!
            if (n.hopUp != null && (up == null || n.hopUp < up)) up = n.hopUp
            if (n.hopDown != null && (down == null || n.hopDown < down)) down = n.hopDown
        }
        const out = { up, down }
        hopCache.set(urn, out)
        return out
    }
    /** Downstream wins a tie, so a node the same distance either way
     *  reads as a consumer rather than flickering between columns. */
    const signedHop = (urn: string): number => {
        const { up, down } = hopsOf(urn)
        if (down != null && (up == null || down <= up)) return down
        if (up != null) return -up
        return 0
    }

    // Type chips REMOVE — and take what is inside with them, because a
    // column whose table was chipped away has nothing left to hang from.
    // Never the focus or the containers above it: chipping the focus's
    // own type would delete the thing you are looking at.
    let hiddenByChips = 0
    let hiddenByChipsIn = 0
    let hiddenByChipsOut = 0
    if (hiddenTypes.size > 0) {
        const kept = new Set<string>([sg.focusUrn, ...ancestorsOf(sg.focusUrn)])
        const doomed = new Set<string>()
        for (const urn of [...population].sort()) {
            if (kept.has(urn) || !hiddenTypes.has(typeFor(urn))) continue
            for (const inside of subtreeOf(urn)) {
                if (!kept.has(inside) && population.has(inside)) doomed.add(inside)
            }
        }
        for (const urn of doomed) {
            // Sided BEFORE the removal, from the same signed-hop rule the
            // columns use, so the count lands under the band it emptied.
            const side = signedHop(urn)
            hiddenByChips += 1
            if (side <= 0) hiddenByChipsIn += 1
            if (side > 0) hiddenByChipsOut += 1
        }
        for (const urn of doomed) population.delete(urn)
        // Those hops were memoized against a population that has just
        // shrunk; every column has to be re-read from what is left.
        hopCache.clear()
    }

    // ── 2. PRESENTED UNITS — the FLATTEN ─────────────────────────────
    //
    // Every lineage-bearing TABLE is its own node, in the hop column its
    // own hop dictates. Nothing is ever a box around tables: the levels
    // above a table are breadcrumb text on it, and a container the reader
    // has not drilled is ONE ROLLUP CARD standing for its members.
    //
    // Reported live and locked by the user (2026-08-14): `GOLD`'s seven
    // tables drawn inside one GOLD frame put every peer flow between them
    // OUTSIDE the box and back in — a knot of arcs with no left-to-right
    // reading — and pinned all seven into the column of whichever member
    // was nearest, so hop 2 and hop 3 sat in the hop-1 band. Flat, those
    // are ordinary node→node wires across the columns and the knot cannot
    // form.

    const childrenInPopulation = (urn: string): string[] =>
        (nodeOf(urn)?.children ?? []).filter(c => population.has(c))

    /** The containment chain above the focus. Never geometry, so it is
     *  never a presented unit either — it is the focal's breadcrumb. */
    const focusAncestors = new Set(ancestorsOf(sg.focusUrn))
    const focusSubtree = subtreeOf(sg.focusUrn)

    /** Entities the data source itself put on a hop. They are what the
     *  picture is OF at their grain, so nothing is ever seen through
     *  one — and no level dropped from the geometry can be carrying a
     *  wire. */
    const carriesHop = new Set<string>()
    for (const hop of sg.lineageEdges) {
        if (!population.has(hop.sourceUrn) || !population.has(hop.targetUrn)) continue
        carriesHop.add(hop.sourceUrn)
        carriesHop.add(hop.targetUrn)
    }

    /** Does this entity HOLD anything — whether or not this walk shipped
     *  it? The declared count counts: a table whose lineage attaches at
     *  TABLE grain ships none of its 22 columns, and it is still a table.
     *
     *  This is the ONE line that separates a table from a container. A
     *  hop-carrier that holds things is a NODE (`dim_customer`, 22
     *  columns, wired at its own grain); a hop-carrier that holds nothing
     *  is a COLUMN, and belongs in its owner's card as a row. */
    const holdsThings = (urn: string): boolean => {
        if ((nodeOf(urn)?.children.length ?? 0) > 0) return true
        const declared = dataOf(urn).childCount
        return typeof declared === 'number' && declared > 0
    }

    /** A hop that ends on something with nothing inside it: a column. */
    const isLeafHopCarrier = (urn: string): boolean =>
        carriesHop.has(urn) && !holdsThings(urn)

    /** The card a hop-carrier is DRAWN as — itself, or, for a column, the
     *  table that owns it (the landed T14-I4 rule). */
    const unitOf = (urn: string): string => {
        const parent = nodeOf(urn)?.parent ?? null
        return isLeafHopCarrier(urn) && parent && population.has(parent) ? parent : urn
    }

    /** THE PRESENTED UNITS: every partner card the board draws. The focus
     *  and its contents are not among them (the focal card and its
     *  contains-stack are those), and neither is anything above the focus
     *  — a hop that lands there has no card and is said out loud instead
     *  (`hopsAtCoarserGrain`). */
    const units = new Set<string>()
    for (const urn of population) {
        if (!carriesHop.has(urn)) continue
        const u = unitOf(urn)
        if (focusSubtree.has(u) || focusAncestors.has(u)) continue
        units.add(u)
    }

    /** The units a container would put on the board if it were drilled:
     *  the ROOT-MOST ones under it, since a unit nested in a unit is
     *  reached by drilling that one. */
    const topmostUnitsIn = (urn: string): string[] => {
        const out: string[] = []
        const stack = [...childrenInPopulation(urn)]
        while (stack.length > 0) {
            const next = stack.pop()!
            if (units.has(next)) { out.push(next); continue }
            for (const kid of childrenInPopulation(next)) stack.push(kid)
        }
        return out
    }

    /** Containment levels that draw NO card of their own — chrome walked
     *  through — and the ones the reader has DRILLED, which is the same
     *  thing by request: the rollup is replaced by what it stood for. */
    const chrome = new Set<string>()
    const drilled = new Set<string>()
    /** ...and the ones that DO draw a card while standing for members
     *  they do not: `GOLD · 7 on this lineage · of 8`. */
    const rollups = new Set<string>()
    const classified = new Set<string>()
    const classify = (urn: string) => {
        if (classified.has(urn) || !population.has(urn)) return
        classified.add(urn)
        // THE FOCUS IS NEVER CHROME, whatever its shape: it is the thing
        // you asked about, so it always gets its card and its
        // contains-stack. Its contents are the stack's rows and are
        // classified by nobody.
        if (urn === sg.focusUrn) return
        const kids = childrenInPopulation(urn)
        if (kids.length === 0) return
        // ABOVE THE FOCUS: breadcrumb, never geometry. (R1)
        if (focusAncestors.has(urn)) {
            chrome.add(urn)
            for (const kid of kids) classify(kid)
            return
        }
        // A TABLE. Its columns are its rows; anything else it holds is a
        // card of its own, so keep walking.
        if (units.has(urn)) {
            for (const kid of kids) classify(kid)
            return
        }
        // A CONTAINER. One unit under it is chrome — a box around one
        // table says what one word of breadcrumb says, for ~90px. Several
        // is a genuine choice, so it is a ROLLUP until the reader drills
        // it.
        //
        // STICKY (`view.walkedThrough`), because the population only ever
        // grows: a level seen through while it held one table would
        // become a rollup the moment a second arrived, and the card
        // already on the board would vanish inside it. Nothing drawn may
        // be taken away by a walk growing.
        const opened = view.expandedContainment.has(urn) && !view.collapsedContainment.has(urn)
        if (topmostUnitsIn(urn).length <= 1 || view.walkedThrough.has(urn)) {
            chrome.add(urn)
            for (const kid of kids) classify(kid)
            return
        }
        if (opened) {
            drilled.add(urn)
            for (const kid of kids) classify(kid)
            return
        }
        rollups.add(urn)
    }
    for (const urn of population) {
        if ((model.get(urn)?.parent ?? null) === null) classify(urn)
    }
    /** Fed back into the next build's `LensViewState.walkedThrough`. */
    const walkedThrough = new Set(chrome)

    // ── 3. VISIBILITY ────────────────────────────────────────────────

    // WHAT IS OPEN — and nothing else is. THE CAP ON GRAIN, which
    // deleting the frames must not delete with them.
    //
    //   • CHROME and DRILLED containers, because they draw nothing: shut,
    //     they would take the members they stand between off the board.
    //   • A TABLE onto its OWN CONNECTED COLUMNS — the landed answer-grain
    //     rule. Those columns ARE the answer at that grain, and they are
    //     rows of one card rather than cards of their own.
    //   • Whatever the reader opened by hand.
    //
    // Everything else stands for what it holds until it is asked. A
    // container that carries a hop of its own AND holds seven tables is
    // ONE card until it is drilled.
    //
    // Reported live, mid-flight (2026-08-14 12.15): opening every level by
    // default drew the whole estate as a single narrow vertical strip —
    // every table at column grain and every container's members promoted
    // beside it, dozens of cards stacked at one or two x positions with
    // the focal buried among them. The columns are the skeleton of this
    // picture; a board with no x-spread is not a flatter version of the
    // old one, it is a list.
    const expanded = new Set<string>([...chrome, ...drilled, sg.focusUrn])
    for (const urn of units) {
        if (childrenInPopulation(urn).some(isLeafHopCarrier)) expanded.add(urn)
    }
    for (const urn of view.expandedContainment) expanded.add(urn)
    for (const urn of rollups) expanded.delete(urn)
    for (const urn of view.collapsedContainment) expanded.delete(urn)

    // Pre-order, parents before children: `visibleLensNodes` stops at any
    // closed node, which IS the "every ancestor must be open" rule, and
    // the population is ancestor-closed so nothing is stranded.
    const visibleOrder = visibleLensNodes(sg, expanded).filter(u => population.has(u))
    const visible = new Set(visibleOrder)

    /** What is INSIDE the focus: its contains-stack rows. */
    const focusContents = new Set(focusSubtree)
    focusContents.delete(sg.focusUrn)

    /**
     * What the focus can honestly offer to walk, per direction — see
     * `boundaryFrontierFilter`, which is also what seeds the extend the ⊕
     * fires (`seedLeavesFor`), so the badge and the fetch can never
     * disagree about what one click can go and get.
     *
     * The focus's OWN frontier is offered unless the picture has proven
     * it interior — it has hops this way and every one of them stays
     * inside. "Nothing walked this way yet" is not interior, and that is
     * the case an unwalked direction's ⊕ exists for.
     *
     * A node INSIDE the focus may speak for the focus's walk only when it
     * is a BOUNDARY CROSSER: something the picture has seen reach out. Its
     * remainder plausibly reaches out too, and a fetch seeded from it has
     * somewhere to go. Its own unfetched adjacency is otherwise a fact
     * about IT, not about the thing the reader asked about.
     *
     * On this estate that is the whole of the report: the aggregation
     * worker materialises a rollup hop from every interior column to the
     * platform, so the platform's own `totalCount` of 321 is 321 pieces
     * of its own inside, and its 50 interior frontier entries are 50 more.
     *
     * A table whose columns carry its lineage keeps its ⊕: those columns'
     * hops LEAVE the table, so their remainder leaves it too.
     *
     * OUTSIDE the focus nothing changes: a partner card's frontier is a
     * statement about the partner, and this rule never touches it.
     */
    const offerable = {
        in: boundaryFrontierFilter(sg, sg.focusUrn, 'in'),
        out: boundaryFrontierFilter(sg, sg.focusUrn, 'out'),
    }
    /**
     * A HOP LANDS AT THE FINEST VISIBLE GRAIN ON BOTH ENDS.
     *
     * So every card on the board is an endpoint — the focus's own
     * contains-stack rows included, the moment they are on screen. Which
     * column feeds which is the whole reason to open two tables to their
     * columns, and it is what every catalogue that draws this shows.
     *
     * Reported (Issue A): partner tables opened to their columns wired
     * into the FOCAL's single port while the focus's own columns sat
     * un-wired underneath it, so the picture drew a table's worth of
     * lineage as one arrow and answered nothing.
     *
     * The focal's single ports keep the job they were built for — the
     * rollup target for a hop whose finer end is NOT drawn. `nearestVisible`
     * decides that per hop, so shutting the stack turns eight column
     * wires back into one bundle with no other machinery involved.
     *
     * What is NOT drawn: a hop with both ends inside the focus. That is
     * the contents talking among themselves — it feeds their ×N counts
     * and the drill, and as a wire it leaves the contains-stack and comes
     * straight back into it, which is the tower in miniature. The same
     * boundary rule the ⊕ and Reach obey, in geometry.
     */
    const wired = new Set(visibleOrder)
    const projected = projectLensEdges(sg, population, wired, subtreeOf(sg.focusUrn))

    /**
     * What each card SPEAKS FOR: itself, plus every population member
     * whose nearest speaking ancestor it is.
     *
     * This is `projectLensEdges`'s own nearest-ancestor rule applied to
     * the ⊕ — and it has to be, or a frontier gets
     * reported once per containment level above it. Five nested frames
     * each grew their own copy of one column's "+2", four of which could
     * not be acted on separately and which piled up on top of each other
     * in the gutter. A card offers exactly what it stands for — and the
     * focal, standing for its whole subtree, offers the table's frontier
     * once rather than once per column.
     *
     * WIRING and SPEAKING are two different questions, and the
     * contains-stack is where they come apart: its rows carry wires but
     * never a ⊕ of their own (one offer per element — the focal speaks
     * for everything inside it), so they are endpoints and not speakers.
     * Everything else on the board is both.
     */
    const speakers = new Set([...visibleOrder].filter(u => !focusContents.has(u)))
    const standsFor = new Map<string, Set<string>>()
    for (const urn of speakers) standsFor.set(urn, new Set([urn]))
    for (const urn of population) {
        if (speakers.has(urn)) continue
        let cursor: string | null = model.get(urn)?.parent ?? null
        const guard = new Set<string>()
        while (cursor && !guard.has(cursor)) {
            if (speakers.has(cursor)) { standsFor.get(cursor)!.add(urn); break }
            guard.add(cursor)
            cursor = model.get(cursor)?.parent ?? null
        }
    }
    const ownedBy = (urn: string): ReadonlySet<string> => standsFor.get(urn) ?? new Set([urn])

    // Which sides of a card already have a wire on them. A drained
    // direction that is DRAWN needs no "the walk ends here" mark — the
    // picture says it. One that is empty does.
    const drawnIn = new Set(projected.map(e => e.targetUrn))
    const drawnOut = new Set(projected.map(e => e.sourceUrn))

    // ── 3b. NO WRAPPERS AT ALL ───────────────────────────────────────
    //
    // A containment level draws a card only when it IS the answer at its
    // own grain — a table, or a container standing for members it does
    // not draw. Everything else is DEMOTED: no card, its members promoted
    // to the top level of their own hop columns, each carrying the
    // breadcrumb of where it came from.
    //
    //   • ABOVE THE FOCUS. The thing you asked about anchors the picture
    //     and is never enclosed; what is above it is the focal breadcrumb.
    //   • CHROME — a container with one unit under it. ~90px of box per
    //     level to say what one word of breadcrumb says.
    //   • DRILLED — the reader asked for its members, so the rollup is
    //     replaced by them. That is what drilling MEANS here.
    //
    // Reported live and then locked by the user: `GOLD` holding seven
    // tables drew every peer flow between them as an arc leaving the box
    // and coming back into it, and pinned hop-2 and hop-3 members into
    // the hop-1 column. There is no box now, so there is no arc.
    const visibleChildrenOf = (urn: string): string[] =>
        (nodeOf(urn)?.children ?? []).filter(c => visible.has(c))

    const demoted = new Set<string>()
    for (const urn of visibleOrder) {
        // Never the focus, whatever its shape — and never a level whose
        // members are all hidden, or demoting it would take them off the
        // board with it.
        if (urn === sg.focusUrn || visibleChildrenOf(urn).length === 0) continue
        if (focusAncestors.has(urn) || chrome.has(urn) || drilled.has(urn)) demoted.add(urn)
    }

    // A demoted level is off the board, but what the DATA SOURCE said
    // about it — an unfetched frontier of its own — still has to be
    // offerable somewhere, or the ⊕ it earned is simply gone. Fold it
    // into the card its group is presented as: above the focus that is
    // the focal (where you are standing), and below it a walked-through
    // level has exactly one unit under it by construction.
    //
    // FRONTIERS ONLY, deliberately kept out of `standsFor`: what a card
    // stands for also decides what its REVEAL offers, and the admission
    // loop admits a page from the card's own SUBTREE. Folding a level
    // from above into that would count neighbours no click could reach —
    // the one thing a pill must never do.
    const foldedFrontiers = new Map<string, Set<string>>()
    const unitUnder = (urn: string): string | null => {
        let cursor: string | null = urn
        const guard = new Set<string>()
        while (cursor && demoted.has(cursor) && !guard.has(cursor)) {
            guard.add(cursor)
            const kids = visibleChildrenOf(cursor)
            // A DRILLED container has several members and no single heir.
            // Its own frontier waits until the reader collapses it back to
            // a rollup, which is the card that can offer it honestly:
            // folding it onto one arbitrary member would be a number that
            // member's click could not deliver, and onto all of them would
            // be the same number said several times.
            cursor = kids.length === 1 ? kids[0] : null
        }
        return cursor
    }
    for (const urn of demoted) {
        const node = model.get(urn)
        if (!node?.frontierUp && !node?.frontierDown) continue
        // NEVER from ABOVE the focus. A badge is a promise about what one
        // click delivers, and the focal's extend is seeded from the
        // FOCUS's own leaves — it cannot fetch a containment ancestor's
        // adjacency at the ancestor's coarser grain.
        //
        // Reported live: a column whose platform carries `:AGGREGATED`
        // rollups grew a "+320" on the focal (321 the platform reports,
        // less the 1 hop in hand). Clicking it returned the column's own
        // ancestor chain — four nodes already held, nothing drawn — and
        // the badge stayed +320 forever. Those coarser hops are already
        // stated honestly, once, by `hopsAtCoarserGrain`.
        if (focusAncestors.has(urn)) continue
        const host = unitUnder(urn)
        if (!host || host === urn) continue
        const folded = foldedFrontiers.get(host) ?? new Set<string>()
        folded.add(urn)
        foldedFrontiers.set(host, folded)
    }

    /** Is this entity a card in its OWN right, wherever it happens to sit
     *  in the containment tree? A table, a rollup, or a level that is
     *  demoted and whose members are. Everything else a card holds is one
     *  of its ROWS. */
    const drawsOwnCard = (urn: string): boolean =>
        units.has(urn) || rollups.has(urn) || demoted.has(urn)

    /** The cards that get a hop column of their own. NOTHING encloses
     *  anything here: a table nested inside another table, or inside a
     *  drilled container, is a top-level card exactly like one that is
     *  not — its containment is stated by its breadcrumb. */
    const topLevelUnits: string[] = []
    const unitGuard = new Set<string>()
    const collectUnits = (urn: string) => {
        if (unitGuard.has(urn)) return
        unitGuard.add(urn)
        if (!demoted.has(urn)) topLevelUnits.push(urn)
        for (const kid of visibleChildrenOf(urn)) {
            // Rows stay rows; anything that is a card of its own comes out
            // to the top level.
            if (demoted.has(urn) || drawsOwnCard(kid)) collectUnits(kid)
        }
    }
    for (const urn of visibleOrder) {
        if ((nodeOf(urn)?.parent ?? null) === null) collectUnits(urn)
    }

    // ── 4. CARDS ─────────────────────────────────────────────────────

    const cards: FocusCard[] = []
    const cardIdByUrn = new Map<string, string>()
    /** One entity, one card — structurally, not by convention. A second
     *  card for an entity already on the board is refused whatever path
     *  finds it (a diamond puts the same node upstream AND downstream). */
    const pushCard = (card: FocusCard): string => {
        if (card.nodeId === null) { cards.push(card); return card.id }
        const existing = cardIdByUrn.get(card.nodeId)
        if (existing) return existing
        cardIdByUrn.set(card.nodeId, card.id)
        cards.push(card)
        return card.id
    }

    const needle = query.trim().toLowerCase()
    const matches = (label: string): boolean => needle === '' || label.toLowerCase().includes(needle)

    /** Raw hops this card's subtree carries to the rest of the picture —
     *  what the wires into it add up to, and the rank of its slot. */
    const weightCache = new Map<string, number>()
    const weightOf = (urn: string): number => {
        const hit = weightCache.get(urn)
        if (hit !== undefined) return hit
        const sub = subtreeOf(urn)
        let n = 0
        for (const hop of sg.lineageEdges) {
            if (!population.has(hop.sourceUrn) || !population.has(hop.targetUrn)) continue
            if (sub.has(hop.sourceUrn) === sub.has(hop.targetUrn)) continue
            n += 1
        }
        weightCache.set(urn, n)
        return n
    }
    // ── crossing reduction: one barycenter pass ──────────────────────
    //
    // A column of forty cards wired to a column of thirty draws 1,200
    // possible crossings, and the order they happen to be stacked in
    // decides how many of them are real. So each column is ordered
    // against the one ALREADY PLACED nearer the focus: a card sits at the
    // average height of the neighbours it is wired to over there.
    //
    // One pass, no iteration to a fixpoint: it is a heuristic, it must be
    // deterministic, and — critically — it must compose with the frozen
    // slot rule below. Rank wins over barycenter, so this only ever
    // orders ARRIVALS; a card already on the board never moves because
    // the walk grew a better arrangement underneath it.

    const topLevelSet = new Set(topLevelUnits)
    const hostCache = new Map<string, string | null>()
    /** The top-level card an endpoint belongs to — itself, or whichever
     *  card it is drawn inside. */
    const topLevelHost = (urn: string): string | null => {
        const hit = hostCache.get(urn)
        if (hit !== undefined) return hit
        let cursor: string | null = urn
        const guard = new Set<string>()
        while (cursor && !guard.has(cursor)) {
            if (topLevelSet.has(cursor)) break
            guard.add(cursor)
            cursor = model.get(cursor)?.parent ?? null
        }
        const out = cursor && topLevelSet.has(cursor) ? cursor : null
        hostCache.set(urn, out)
        return out
    }

    /** urn → the top-level cards it is wired to, both directions. */
    const wiredTo = new Map<string, Set<string>>()
    const linkWire = (from: string, to: string) => {
        const set = wiredTo.get(from) ?? new Set<string>()
        set.add(to)
        wiredTo.set(from, set)
    }
    for (const bundle of projected) {
        const sHost = topLevelHost(bundle.sourceUrn)
        const tHost = topLevelHost(bundle.targetUrn)
        if (!sHost || !tHost || sHost === tHost) continue
        linkWire(bundle.sourceUrn, tHost)
        linkWire(bundle.targetUrn, sHost)
        linkWire(sHost, tHost)
        linkWire(tHost, sHost)
    }

    /** Where each top-level card sits in its own column, filled in as the
     *  columns are ordered outward from the focus. */
    const orderIndex = new Map<string, number>()
    const NO_BARYCENTER = Number.MAX_SAFE_INTEGER
    /** The average slot of everything this entity is wired to in the
     *  columns already placed. `NO_BARYCENTER` when none of them are. */
    const barycenterOf = (urn: string): number => {
        let sum = 0
        let n = 0
        for (const host of wiredTo.get(urn) ?? []) {
            const at = orderIndex.get(host)
            if (at === undefined) continue
            sum += at
            n += 1
        }
        return n === 0 ? NO_BARYCENTER : sum / n
    }

    /** A card already on the board keeps the slot it was first drawn in;
     *  anything else is ordered to cross as little as possible, then by
     *  weight, behind all of them. */
    const UNDRAWN = Number.MAX_SAFE_INTEGER
    const drawnRankOf = (urn: string): number => view.drawnRank.get(urn) ?? UNDRAWN
    const rankCards = (urns: string[]): string[] =>
        [...urns].sort((a, b) =>
            drawnRankOf(a) - drawnRankOf(b)
            || barycenterOf(a) - barycenterOf(b)
            || weightOf(b) - weightOf(a)
            || labelFor(a).localeCompare(labelFor(b))
            || a.localeCompare(b))

    // ── pills ────────────────────────────────────────────────────────

    /**
     * The one ⊕ this card offers in this direction, or null when the walk
     * here is drained. Three states, in priority order:
     *
     *   reveal — neighbours ALREADY IN THE MODEL that this page hasn't
     *            shown yet. Free: no fetch, exact count.
     *   page   — the server handed back a cursor for a partial adjacency;
     *            carry it verbatim.
     *   extend — the server says more exists beyond the model. Exact
     *            remainder when it reported a total, a countless chevron
     *            when it did not (never a fabricated number).
     *
     * THE ANCHORING CONTRACT, one rule for all three kinds:
     *
     *   `key` is `${dir}:${urn}` where `urn` is the node the consumer
     *   passes as the FIRST ARGUMENT to the matching walk-hook call, and
     *   `status` for that pill comes back on that same urn (via
     *   `walkStatusKey`, which is the only in/out ↔ up/down translation).
     *
     * The urn differs by kind, and it has to. `extend` is CARD-anchored:
     * the consumer calls `extend(cardUrn, dir, seedLeaves)` with the
     * leaves gathered from the card's own subtree, and `useLensWalk` keys
     * its in-flight map by that same cardUrn — so a collapsed table whose
     * frontier really belongs to two hidden columns is extended as the
     * TABLE, seeded by those columns, and its spinner arrives at the
     * table. `page` is NODE-anchored, because a cursor is meaningless
     * anywhere but on the node the server issued it for; the key names
     * that node, and `page(thatUrn, dir, cursor)` is what the consumer
     * calls. Both obey the one rule: split the key, pass the urn.
     */
    /**
     * Is something DRAWN INSIDE this card already offering these reveals?
     *
     * The subtree set the pill and the click now share is the right set to
     * COUNT and to ADMIT — but not always the right place to OFFER. An open
     * frame's rows are cards of their own, each with its own ⊕ against its
     * own neighbours; a frame that offered them again would grow a second
     * copy of every row's pill in its gutter, which is the confetti
     * `standsFor` was built to stop.
     *
     * So the offer goes to the finest grain that can act on it, and a card
     * with a wired descendant that still has something free waits. It loses
     * nothing: its own question comes back the moment those are drawn, and
     * until then the rows' pills are sitting right there. It is also what
     * keeps the fetch honest — see `pillFor`'s frontier branch.
     */
    const drawnInsideOffers = (urn: string, dir: LensDir): boolean => {
        const sub = subtreeOf(urn)
        for (const hop of sg.lineageEdges) {
            const from = dir === 'in' ? hop.targetUrn : hop.sourceUrn
            const far = dir === 'in' ? hop.sourceUrn : hop.targetUrn
            // A hop out of a descendant that is drawn in its own right...
            if (from === urn || !sub.has(from) || !wired.has(from)) continue
            // ...to something this card does not already contain...
            if (sub.has(far) || seed.has(far)) continue
            // ...and has not yet put on the board.
            if (!population.has(far)) return true
        }
        return false
    }

    const pillFor = (urn: string, dir: LensDir): FocusPill | null => {
        // What this direction could still show from data already in hand:
        // the REMAINDER, not one page of it. A group another card's reveal
        // already put on the board is not offered again, and — because the
        // admission loop charges a page only for what it introduces — every
        // group counted here is one a click can actually reach.
        //
        // THE SAME CALL the admission loop makes for this key, so the badge
        // below counts exactly the set one click draws from, and a fetch is
        // never offered while anything free is still queued underneath it.
        const remainingGroups = rankedGroups(dir, urn)
            .filter(g => g.members.some(m => !population.has(m)))
        // Something drawn inside this card offers these already, at the
        // grain that owns them. Nothing is offered twice, and nothing is
        // offered here until they are gone — which is also what makes the
        // frontier branch below safe to reach.
        if (remainingGroups.length > 0 && drawnInsideOffers(urn, dir)) return null
        if (remainingGroups.length > 0) {
            // CONNECTIONS, the same unit every other number on this board
            // uses — the band headers, a card's ×N, the focal's in/out. A
            // reveal that counted GROUPS put two different units in one
            // place on one card: "+246" (connections the server has not
            // shipped) became "+1" (one group in hand) after a click, and
            // the badge read as changing its mind about how much was out
            // there. Exact here, because these hops are already in hand.
            let count = 0
            for (const g of remainingGroups) {
                for (const m of g.members) {
                    if (!population.has(m)) count += g.memberWeight.get(m) ?? 0
                }
            }
            return {
                kind: 'reveal',
                count,
                // How many CARDS one click puts on the board — the wording
                // needs it (a page is a page of groups, not of hops), and
                // the badge must never be it.
                groups: remainingGroups.length,
                key: revealKey(dir, urn),
                cursor: undefined,
                status: undefined,
            }
        }
        // The card speaks for what it stands for — its own frontier, plus
        // that of anything collapsed inside it, plus that of any level
        // the picture walked THROUGH to present this card.
        //
        // Reaching here means NOTHING reachable from this card's subtree is
        // still waiting to be drawn — the reveal branch above returned on
        // both of its outcomes. That is the invariant the consumer's
        // extend/page click leans on: the reveal page it opens has no
        // competitor, so the cohort it fetches is the only thing that page
        // can spend itself on. Break it and the P1 comes back.
        //
        // `ownedBy` and NOT the subtree here, unlike the reveal above: a
        // frontier is a fact about ONE node, and a card whose rows are
        // drawn separately must not re-offer theirs — five nested frames
        // each growing their own copy of one column's "+2" is what this
        // set exists to prevent.
        //
        // Never a remainder the picture's own evidence says is INTERIOR
        // to the focus — see `offerable` above. That is the whole of the
        // reported "+211 that grew to +384 and drew nothing".
        const entries = [...ownedBy(urn), ...(foldedFrontiers.get(urn) ?? [])]
            .filter(u => offerable[dir](u))
            .sort()
            .map(u => ({ urn: u, node: model.get(u)! }))
            .map(({ urn: u, node }) => ({
                urn: u,
                entry: dir === 'in' ? node.frontierUp : node.frontierDown,
                degree: dir === 'in' ? node.degreeUp : node.degreeDown,
            }))
            .filter(e => e.entry != null)
        if (entries.length === 0) return null

        let count: number | null = 0
        for (const e of entries) {
            if (e.entry!.totalCount == null) { count = null; break }
            count = (count ?? 0) + Math.max(0, e.entry!.totalCount - e.degree)
        }
        const paging = entries.find(e => e.entry!.nextCursor != null)
        if (paging) {
            return {
                kind: 'page',
                count,
                key: revealKey(dir, paging.urn),
                cursor: paging.entry!.nextCursor!,
                status: extendStatus.get(walkStatusKey(dir, paging.urn)),
            }
        }
        // A known remainder of zero is not a pill promising nothing.
        if (count === 0) return null
        return {
            kind: 'extend',
            count,
            key: revealKey(dir, urn),
            cursor: undefined,
            status: extendStatus.get(walkStatusKey(dir, urn)),
        }
    }

    const baseCard = (): Omit<FocusCard, 'id' | 'kind' | 'nodeId' | 'band' | 'label' | 'type'> => ({
        x: 0, y: 0, w: CARD_W, h: CARD_H,
        description: null, freshness: null,
        parentId: null, parentLabel: null,
        count: 1, flowsIn: 0, flowsOut: 0, showType: false, edgeTypeNorm: '',
        frameId: null, depth: 0,
        ancestry: EMPTY_STRINGS, ancestryIds: EMPTY_STRINGS,
        frameEmpty: false,
        connected: true, frameShowingAll: false, frameConnectedCount: 0,
        frameLoaded: 0, frameTotal: -1, frameHasMore: false,
        frameSharedEdgeType: '',
        frameOffset: 0, frameWindowSize: FRAME_WINDOW, frameRows: NO_FRAME_ROWS,
        canOpenChildren: false, childrenOpen: false,
        expandKey: null, expanded: false, wired: false, deadEnd: false,
        rollup: false, selfFlows: 0, portsIn: 0, portsOut: 0,
        fetch: null, dimmed: false,
        pillUp: null, pillDown: null, contents: null,
    })

    /** The card's own ⊕ state and whether the walk genuinely ends here.
     *  A direction is only asked about when the card has a presence
     *  there — an upstream card is not asked what is downstream of it. */
    const walkStateOf = (urn: string, isFrame: boolean, band: number) => {
        const { up, down } = hopsOf(urn)
        const isFocus = urn === sg.focusUrn
        const askUp = isFocus || up != null
        const askDown = isFocus || down != null
        // A direction the preset hides never shows a pill for it — this
        // is the ONE place a card's own ⊕ (not just its band of cards)
        // has to respect the filter, since the focal itself sits at
        // band 0 and is never skipped by the roots loop below.
        const upVisible = directionFilter !== 'out'
        const downVisible = directionFilter !== 'in'
        const pillUp = askUp && upVisible ? pillFor(urn, 'in') : null
        const pillDown = askDown && downVisible ? pillFor(urn, 'out') : null
        // The end of a walk is worth stating exactly where the picture
        // does NOT already state it: on the OUTWARD side of a card that
        // has no wire there. A frame never claims it — its rows carry the
        // lineage, and the frame saying "ends here" over an open estate
        // full of live connections is simply false. And "nothing further
        // exists" is a claim about the DATA SOURCE, so it waits for the
        // walk to actually report done — and never fires on a side the
        // user's OWN direction filter hid, or hiding a live frontier
        // would misreport it as the walk having ended.
        const outwardDir: LensDir = band < 0 ? 'in' : 'out'
        const outwardVisible = outwardDir === 'in' ? upVisible : downVisible
        const asked = outwardDir === 'in' ? askUp : askDown
        const pill = outwardDir === 'in' ? pillUp : pillDown
        const drawn = outwardDir === 'in' ? drawnIn.has(urn) : drawnOut.has(urn)
        const deadEnd = walkStatus === 'done' && !isFrame && asked && outwardVisible && pill === null && !drawn
        return { pillUp, pillDown, deadEnd }
    }

    /** How many things this entity holds ALTOGETHER, when it says so:
     *  the payload's own count first, then whatever the roster has
     *  reached. Never a guess. */
    const heldTotal = (urn: string): number | null => {
        const declared = dataOf(urn).childCount
        return typeof declared === 'number' && declared >= 0
            ? declared
            : childrenAll.get(urn)?.total ?? null
    }

    const contentsOf = (urn: string): { onLineage: number; total: number | null } | null => {
        const children = nodeOf(urn)?.children ?? []
        if (children.length === 0) return null
        return { onLineage: children.length, total: heldTotal(urn) }
    }

    /** The type of the one hop this card carries, when it carries exactly
     *  one — a frame states a shared relationship once instead of every
     *  row repeating it. */
    const edgeTypeOf = (cardId: string): string => {
        const types = new Set<string>()
        for (const bundle of projected) {
            const s = cardIdByUrn.get(bundle.sourceUrn)
            const t = cardIdByUrn.get(bundle.targetUrn)
            if (s !== cardId && t !== cardId) continue
            types.add((bundle.edgeTypeNorm || '').toUpperCase())
        }
        return types.size === 1 ? [...types][0] : ''
    }

    /**
     * Emit one entity, then whatever it holds — recursively, to whatever
     * depth the estate goes. There is no two-level promotion cap: a
     * self-nesting ontology (Node ⊃ Node ⊃ Node) nests as many times as
     * the data does.
     */
    const emit = (
        urn: string,
        hostFrameId: string | null,
        depth: number,
        band: number,
        /** The Find text of the frame this row sits in. A search has to
         *  reach what is ON SCREEN — a box that only ever dimmed the
         *  UNCONNECTED extras searched everything except the rows the
         *  frame was opened to show. Dims, like the board-wide filter:
         *  a row removed by a search is a row you cannot see is there. */
        hostQuery = '',
    ) => {
        // ROWS ONLY. A child that is a card in its own right — another
        // table, a rollup, a level whose members are drawn — is out at the
        // top level, wherever it sits in the containment tree. This is the
        // whole flatten in one filter: nothing encloses anything but its
        // own leaves.
        const kids = rankCards(visibleChildrenOf(urn).filter(c => !drawsOwnCard(c)))
        const showAll = view.frameShowAll.has(urn)
        const isFocus = urn === sg.focusUrn
        const label = labelFor(urn)
        // The PROVENANCE RIBBON — the deepest levels, which are the ones
        // that identify the entity. This is where ANCESTRY_CAP belongs and
        // the only place it applies: it says how many crumbs a card
        // prints, and nothing about which entities are in the picture.
        // The two ran together until a seven-level estate came out blank.
        const ancestry = ancestorsOf(urn).slice(-ANCESTRY_CAP)
        const parent = nodeOf(urn)?.parent ?? null

        const roster = childrenAll.get(urn)
        const rosterNodes = new Map((roster?.children ?? []).map(n => [n.id, n]))
        const rosterExtras = showAll
            ? (roster?.children ?? [])
                .map(n => n.id)
                .filter(id => !visible.has(id) && !cardIdByUrn.has(id))
            : []
        // Connected first, then everything else inside — the order the
        // divider row below announces, and the order a reader wants:
        // what answers the question, then what merely lives here.
        //
        // Rows already carded elsewhere are dropped HERE rather than
        // silently refused by `pushCard` when the window reaches them: a
        // row this list counts but never draws is a row the scroll window
        // skips, a count that overstates, and — because the frame's list
        // region OWNS its rows by id for assistive tech — an
        // `aria-owns` naming an element that does not exist and a
        // keyboard cursor that can land on nothing.
        const connectedRows = kids.filter(child => !cardIdByUrn.has(child))
        const rows = [...connectedRows, ...rosterExtras]
        // The FOCUS is always a compact card. What it holds is stated by
        // the contains-stack attached below it (further down), never by
        // swelling the thing you asked about into a frame the rest of the
        // board sits beside.
        const isFrame = rows.length > 0 && !isFocus
        // A CONTAINER standing for members it does not draw. Its chevron
        // does not open a body — it REPLACES this card with those members.
        const isRollup = rollups.has(urn)
        // A row of the contains-stack is CONTENTS. Its lineage is the
        // focus's lineage — drawn at the focal, offered by the focal's ⊕
        // — so a row neither carries a pill of its own nor gets to claim
        // that the walk ended at it. A ROLLUP never claims one either: it
        // is standing in for members whose own ends it cannot see.
        const { pillUp, pillDown, deadEnd } = focusContents.has(urn)
            ? { pillUp: null, pillDown: null, deadEnd: false }
            : walkStateOf(urn, isFrame || isRollup, band)
        const windowSize = showAll ? FRAME_WINDOW_ALL : FRAME_WINDOW
        // The scroll window can never travel past what has loaded: a
        // restored share link, or a roster that shrank under a new
        // search, must land on rows rather than on empty space.
        const offset = Math.min(
            Math.max(0, view.frameOffsets.get(urn) ?? 0),
            Math.max(0, rows.length - windowSize),
        )
        const frameQuery = (view.frameQueries.get(urn) ?? '').trim().toLowerCase()

        const card: FocusCard = {
            ...baseCard(),
            id: isFrame ? `fr:${urn}` : isFocus ? 'f' : `n:${urn}`,
            kind: isFrame ? 'frame' : isFocus ? 'focal' : 'entity',
            nodeId: urn,
            band,
            h: isFrame ? CARD_H : isFocus ? FOCAL_H : CARD_H,
            depth,
            label,
            description: (dataOf(urn).description as string | undefined) ?? null,
            freshness: (dataOf(urn).lastSyncedAt as string | undefined) ?? null,
            type: typeFor(urn),
            frameId: hostFrameId,
            parentId: parent,
            parentLabel: parent ? labelFor(parent) : null,
            ancestry: ancestry.map(labelFor),
            ancestryIds: ancestry,
            count: Math.max(1, weightOf(urn)),
            flowsIn: nodeOf(urn)?.degreeUp ?? 0,
            flowsOut: nodeOf(urn)?.degreeDown ?? 0,
            canOpenChildren: (nodeOf(urn)?.children.length ?? 0) > 0,
            childrenOpen: isFrame,
            expandKey: urn,
            expanded: isFrame,
            wired: drawnIn.has(urn) || drawnOut.has(urn),
            rollup: isRollup,
            contents: contentsOf(urn),
            pillUp,
            pillDown,
            deadEnd,
            frameShowingAll: showAll,
            // Nothing inside this is on this lineage — a fact about the
            // MODEL (the walk ships every lineage-carrying descendant),
            // not about what this page happens to show, so it stays true
            // whatever the chips or the reveal pages have done.
            //
            // It is what makes "everything inside" honest: a table whose
            // lineage attaches at TABLE grain opens onto its columns with
            // "nothing here is on this lineage · showing everything
            // inside", instead of a roster that reads like an answer to a
            // question nobody asked. Carried by the focus too, because
            // its contains-stack is the same frame at a different address.
            frameEmpty: (isFrame || isFocus) && (nodeOf(urn)?.children.length ?? 0) === 0,
            frameConnectedCount: connectedRows.length,
            frameLoaded: showAll ? rows.length : connectedRows.length,
            frameTotal: showAll ? (roster?.total ?? -1) : (contentsOf(urn)?.total ?? -1),
            frameHasMore: showAll ? (roster?.hasMore ?? false) : false,
            frameOffset: offset,
            frameWindowSize: windowSize,
            // Every row, not only the windowed ones: the keyboard cursor
            // and the type-ahead reach rows the window has scrolled past,
            // and neither can ask the board for a card that is not drawn.
            frameRows: isFrame || isFocus
                ? rows.map((child): FrameRowRef => ({
                    urn: child,
                    label: visible.has(child) ? labelFor(child) : labelOf(child, rosterNodes.get(child)),
                    canOpen: visible.has(child) && (nodeOf(child)?.children.length ?? 0) > 0,
                }))
                : NO_FRAME_ROWS,
            fetch: isFocus && walkStatus === 'loading' ? 'loading'
                : isFocus && walkStatus === 'error' ? 'error'
                    : showAll && childrenAllStatus.get(urn) === 'loading' ? 'loading'
                        : showAll && childrenAllStatus.get(urn) === 'error' ? 'error'
                            : null,
            dimmed: !matches(label) || (hostQuery !== '' && !label.toLowerCase().includes(hostQuery)),
        }
        const id = pushCard(card)
        if (id !== card.id) return

        // Rows go inside this card — except the FOCUS's, which go in the
        // CONTAINS-STACK: a card of its own, attached below the focal,
        // saying what is in there and opening to show it. It reuses the
        // frame's internals verbatim (rows, Connected|All, Find, pager),
        // because it is the same question at a different address; what it
        // must not do is enclose the focal.
        let host = card
        if (isFocus) {
            // A table whose lineage attaches at TABLE grain holds plenty
            // and carries none of it on this walk. The stack still opens
            // — that is where "0 on this lineage · of 9" and "nothing
            // inside is on this lineage" get said. Dropping it left the
            // reader with no way to ask what is in there and no statement
            // that the answer is nothing.
            const declared = heldTotal(urn) ?? 0
            const holds = (nodeOf(urn)?.children.length ?? 0) > 0 || rosterExtras.length > 0 || declared > 0
            if (!holds) return
            host = {
                ...card,
                contents: contentsOf(urn) ?? { onLineage: 0, total: heldTotal(urn) },
                id: `co:${urn}`,
                kind: 'frame',
                // No urn of its own: it is the focus's contents, and the
                // focus already has a card. A second card for one entity
                // is exactly what `pushCard` refuses.
                nodeId: null,
                // It keeps the FOCUS'S NAME rather than a bare "Contains":
                // the view heads it "Inside fact_orders", and every count
                // and empty-state sentence built from `label` then names
                // the thing the reader asked about instead of naming a box.
                label,
                description: null,
                h: CARD_H,
                frameId: null,
                // The focal above states where the focus lives; the stack
                // repeating it would be the noise breadcrumbs replaced.
                ancestry: EMPTY_STRINGS,
                ancestryIds: EMPTY_STRINGS,
                parentId: null,
                parentLabel: null,
                childrenOpen: rows.length > 0,
                expanded: rows.length > 0,
                // The walk's own ⊕ belongs to the focal card, once — and
                // so does every wire, so the stack has no ports either.
                pillUp: null,
                pillDown: null,
                wired: false,
                deadEnd: false,
                dimmed: false,
                fetch: showAll && childrenAllStatus.get(urn) === 'loading' ? 'loading'
                    : showAll && childrenAllStatus.get(urn) === 'error' ? 'error'
                        : null,
            }
            pushCard(host)
        } else if (!isFrame) return

        // ONE fixed window of rows, so a 500-column table and a 5-column
        // one occupy the same room and scrolling MOVES the window rather
        // than growing the frame.
        for (let i = offset; i < Math.min(offset + windowSize, rows.length); i++) {
            const child = rows[i]
            // Where "what is on this lineage" ends and "what else is in
            // here" begins — said once, quietly, instead of leaving the
            // reader to notice the rows went grey. Drawn only when the
            // boundary is actually inside the window; scrolled past, it
            // is not a fact about what is on screen.
            if (i === connectedRows.length && connectedRows.length > 0 && rosterExtras.length > 0) {
                pushCard({
                    ...baseCard(),
                    id: `div:${urn}`,
                    kind: 'divider',
                    nodeId: null,
                    band,
                    h: DIVIDER_ROW_H,
                    depth: depth + 1,
                    label: 'everything else inside',
                    type: UNRESOLVED_TYPE,
                    frameId: host.id,
                    count: rosterExtras.length,
                    canOpenChildren: false,
                })
            }
            if (visible.has(child)) {
                emit(child, host.id, depth + 1, band, frameQuery)
                continue
            }
            // Inside this, but off the lineage. Only ever shown in "All",
            // and marked, because it must never read as a connection.
            const node = rosterNodes.get(child)
            const rosterLabel = labelOf(child, node)
            pushCard({
                ...baseCard(),
                id: `n:${child}`,
                kind: 'entity',
                nodeId: child,
                band,
                h: CHILD_ROW_H,
                depth: depth + 1,
                label: rosterLabel,
                description: (node?.data?.description as string | undefined) ?? null,
                // `lastSyncedAt` rides in the payload but is not on the
                // canvas node's declared shape (see toCanvasNode), so it
                // is read the same way the walk model's own payload is.
                freshness: ((node?.data as Record<string, unknown> | undefined)?.lastSyncedAt as string | undefined) ?? null,
                type: (node?.data?.type as string) ?? UNRESOLVED_TYPE,
                frameId: host.id,
                parentId: urn,
                parentLabel: label,
                connected: false,
                count: 0,
                canOpenChildren: false,
                dimmed: !matches(rosterLabel) || (frameQuery !== '' && !rosterLabel.toLowerCase().includes(frameQuery)),
            })
        }
    }

    /**
     * COLUMN BY COLUMN, OUTWARD FROM THE FOCUS — so each one can be
     * ordered against the column already placed beside it.
     *
     * Three rules stacked, in this order and no other:
     *
     *  1. FROZEN SLOTS. A card already on the board holds its place for
     *     this view state's lifetime (`drawnRank`). Ordering therefore
     *     runs ONCE per membership change: arrivals are arranged, nothing
     *     drawn is re-arranged under the pointer of whoever revealed it.
     *  2. ADJACENCY. Cards from the same container sit together, and the
     *     gap between groups is the only thing that says so (GROUP_GAP —
     *     a box around them is the chrome this whole task deleted).
     *  3. CROSSING REDUCTION, inside a group: barycenter against the
     *     placed column, then a source above the sink it feeds where two
     *     of them are wired to each other, then weight, then name.
     */
    const bandOf = new Map<string, number>()
    for (const unit of topLevelUnits) bandOf.set(unit, signedHop(unit))
    const columns = new Map<number, string[]>()
    for (const unit of topLevelUnits) {
        const band = bandOf.get(unit)!
        // The whole band a direction filter hides — never emitted, so its
        // cards, pills AND edges (an edge needs both endpoints' card ids)
        // are all absent at once. Band 0 (the focus's own subtree) is
        // never a "side" and is never skipped.
        if (directionFilter === 'in' && band > 0) continue
        if (directionFilter === 'out' && band < 0) continue
        const list = columns.get(band)
        if (list) list.push(unit)
        else columns.set(band, [unit])
    }
    /** Does `a` feed `b` directly, both of them in this same column? Two
     *  peers of one container at the same hop read left-to-right like
     *  everything else on this board when the source is above the sink. */
    const feeds = (a: string, b: string): boolean =>
        (wiredTo.get(a)?.has(b) ?? false)
        && projected.some(p =>
            topLevelHost(p.sourceUrn) === a && topLevelHost(p.targetUrn) === b)

    const orderColumn = (band: number, list: string[]): string[] => {
        const ranked = rankCards(list)
        if (band === 0) {
            // `layoutBands` centres this band's FOCAL on the midline and
            // hangs the rest below it; the thing you asked about is what
            // the midline is for.
            return [...ranked].sort((a, b) =>
                Number(b === sg.focusUrn) - Number(a === sg.focusUrn))
        }
        // Group by immediate container, groups in the order their first
        // member came out of the ranking — so the frozen slots decide the
        // group order too, and adjacency never moves a drawn card.
        const groups: string[][] = []
        const groupAt = new Map<string, number>()
        for (const urn of ranked) {
            const key = model.get(urn)?.parent ?? `~root:${urn}`
            const at = groupAt.get(key)
            if (at === undefined) { groupAt.set(key, groups.length); groups.push([urn]) }
            else groups[at].push(urn)
        }
        return groups.flatMap(group => {
            // Sources above the sinks they feed, within the group. One
            // stable insertion pass over an already-ordered list: it can
            // only ever move a sink DOWN past a source it is fed by, so it
            // terminates and stays deterministic.
            const out = [...group]
            for (let i = 0; i < out.length; i++) {
                for (let j = i + 1; j < out.length; j++) {
                    if (!feeds(out[j], out[i])) continue
                    out.splice(i, 0, ...out.splice(j, 1))
                    break
                }
            }
            return out
        })
    }

    const bandsOutward = [...columns.keys()].sort((a, b) => Math.abs(a) - Math.abs(b) || a - b)
    for (const band of bandsOutward) {
        const ordered = orderColumn(band, columns.get(band)!)
        // Published BEFORE the next column is ordered — that is what the
        // barycenter reads.
        ordered.forEach((urn, i) => orderIndex.set(urn, i))
        for (const unit of ordered) emit(unit, null, 0, band)
    }

    // ── LAST RESORT: the focus is never missing from its own board ────
    //
    // Everything above is geometry, and geometry has ways of losing
    // things: an estate deeper than the population walk admitted (the
    // reported blank), a root the view state has shut, a containment
    // shape nobody has met yet. None of them change the one fact the
    // reader asked about — this entity, and what connects to it.
    //
    // So: if the model has the focus and the picture does not, draw it.
    // A focal card alone, saying what it is and that the rest could not
    // be placed, is worth incomparably more than an empty board — and
    // `focusRecovered` makes the view say so out loud rather than
    // present a diminished picture as the whole answer.
    //
    // Deliberately a SYMPTOM guard, not a cause fix: it fires after the
    // real repair above (population ancestor-closure) and asserts in dev
    // precisely so the next cause is found rather than absorbed.
    const focusRecovered = model.has(sg.focusUrn) && !cardIdByUrn.has(sg.focusUrn)
    if (focusRecovered) {
        if (import.meta.env.DEV) {
            console.error(
                '[lens] the layout did not place the focus on its own board — recovered the focal card.',
                { focus: sg.focusUrn, cards: cards.length, population: population.size },
            )
        }
        emit(sg.focusUrn, null, 0, signedHop(sg.focusUrn))
    }

    // A frame states its rows' one shared relationship, and that decides
    // the ROW HEIGHT — a row with nothing to put in a subtitle is 36px,
    // not 64. Decided here so the view can never suppress what the layout
    // reserved room for.
    const byId = new Map(cards.map(c => [c.id, c]))
    const rowsByFrame = new Map<string, FocusCard[]>()
    for (const card of cards) {
        if (!card.frameId) continue
        const list = rowsByFrame.get(card.frameId)
        if (list) list.push(card)
        else rowsByFrame.set(card.frameId, [card])
    }
    for (const card of cards) {
        if (card.kind !== 'frame') continue
        const own = (rowsByFrame.get(card.id) ?? []).filter(c => c.kind !== 'divider')
        const types = own.filter(c => c.connected).map(r => edgeTypeOf(r.id))
        card.frameSharedEdgeType = types.length > 0 && types.every(t => t === types[0]) ? types[0] : ''
        // A row states WHICH KIND of thing it is only where its frame
        // holds more than one kind. Eight columns each chipped
        // "schemaField" is eight identical labels crowding out the eight
        // names that differ; a frame holding columns AND views is where
        // the chip is the answer to "what am I looking at".
        //
        // An UNRESOLVED type is not a second kind — it is the absence of
        // one. Counting it turned a single unresolved roster row into a
        // chip on all eight columns, saying "these differ" about rows
        // that do not.
        const kinds = new Set(own.map(c => c.type).filter(t => t !== UNRESOLVED_TYPE))
        for (const row of own) row.showType = kinds.size > 1
    }
    for (const card of cards) {
        if (!card.frameId || !card.connected || card.kind === 'divider') continue
        const host = byId.get(card.frameId)
        if (!host) continue
        card.edgeTypeNorm = edgeTypeOf(card.id)
        // Rows get a row's height — but a FRAME is sized from its own
        // contents by layoutBands, and the FOCUS card carries the rich
        // focal chrome (name, provenance, in/out, reach) that does not
        // fit in 64px. Squashing it there spilled its own text out
        // through the bottom of the container holding it.
        //
        // A nested frame also KEEPS the shared type it just computed
        // from its own rows. Overwriting it with its host's said that
        // `SILVER ⊃ clean_charges ⊃ 8 columns` shared nothing, so all
        // eight columns re-stated `DERIVES FROM` and grew to 64px while
        // the identical table one column over stayed at 36px — and the
        // eight wires between them fanned instead of running parallel.
        if (card.kind === 'frame' || card.kind === 'focal') continue
        card.frameSharedEdgeType = host.frameSharedEdgeType
        card.h = rowHeight(host.frameSharedEdgeType, card.edgeTypeNorm)
    }

    // ── edges ────────────────────────────────────────────────────────

    /**
     * A hop that runs STRICTLY backwards in the picture's own hop
     * numbering: `B → A` where A is genuinely nearer the focus than B on
     * the same side. Stated per-direction because a node can legitimately
     * sit on both sides of a diamond without any cycle existing.
     *
     * STRICT since the flatten. The old `≤` also stamped every wire
     * between two cards at the SAME hop — and once containers stopped
     * being boxes, an ordinary peer flow between two tables of one
     * container (`fact_orders → dim_customer`, both one hop from the
     * focus) became the common shape on the board. A loop badge on it is
     * a claim about the data that is simply false, and the reader has no
     * way to tell it from the true loops beside it.
     *
     * What a same-hop pair CAN be is a real cycle, and that is caught by
     * the directed-cycle pass below rather than guessed at from numbering.
     */
    const runsBackwards = (bundle: ProjectedLensEdge): boolean => {
        const s = hopsOf(bundle.sourceUrn)
        const t = hopsOf(bundle.targetUrn)
        if (s.down != null && t.down != null && t.down < s.down) return true
        if (s.up != null && t.up != null && s.up < t.up) return true
        return false
    }

    /**
     * The card a hop can actually LAND on: this entity's own, or — when
     * it has none — the nearest containment ancestor that does.
     *
     * `projectLensEdges` resolves an endpoint against what is VISIBLE,
     * which is a statement about the model. Having a CARD is a statement
     * about the board, and the two differ: a frame draws only the rows in
     * its scroll window, so a hop into row 9 of an 8-row window resolves
     * to a visible node with no card anywhere.
     *
     * Those hops used to be counted as connecting "at a coarser grain"
     * and dropped. That was specific and false — an off-window column is
     * the SAME grain, just scrolled past — and on a 14-column estate it
     * silently deleted six wires while the focal claimed six connections
     * at a grain it does not draw. Rolling up to the frame is what the
     * picture already does for everything else it cannot show finely, and
     * it keeps the promise the whole builder rests on: a hop in the model
     * is a wire on the board.
     */
    const landingUrn = (urn: string): string | null => {
        let cursor: string | null = urn
        const guard = new Set<string>()
        while (cursor && !guard.has(cursor)) {
            if (cardIdByUrn.has(cursor)) return cursor
            guard.add(cursor)
            cursor = model.get(cursor)?.parent ?? null
        }
        return null
    }

    // Hops with no drawn card at either end — a containment ancestor of
    // the FOCUS that the data source also put on a hop, which this
    // picture never boxes. Said out loud on the focal instead of
    // vanishing, and it is what explains a partner card with no wire.
    let hopsAtCoarserGrain = 0
    // Rolling up MERGES: two off-window rows of one frame reaching the
    // same card are one wire saying two, not two wires with one id.
    const byPair = new Map<string, FocusEdge>()
    for (const bundle of projected) {
        const sUrn = landingUrn(bundle.sourceUrn)
        const tUrn = landingUrn(bundle.targetUrn)
        if (!sUrn || !tUrn) { hopsAtCoarserGrain += bundle.weight; continue }
        // BOTH ENDS ON ONE CARD. A collapsed container whose members feed
        // each other, or an entity the data source wired to itself: it is
        // a fact, and it is never a wire — a line that leaves a card and
        // comes straight back into it is the arc that reads as a broken
        // arrow. Said as a compact badge on the card instead.
        if (sUrn === tUrn) {
            const self = byId.get(cardIdByUrn.get(sUrn)!)
            if (self) self.selfFlows += bundle.weight
            continue
        }
        // One end rolled up into something that CONTAINS the other — an
        // off-window row and its own frame. The contents talking among
        // themselves; their rows' counts and the drill say it.
        if (subtreeOf(sUrn).has(tUrn) || subtreeOf(tUrn).has(sUrn)) continue
        const source = cardIdByUrn.get(sUrn)!
        const target = cardIdByUrn.get(tUrn)!
        const id = `e:${source}>${target}`
        const existing = byPair.get(id)
        const norm = (bundle.edgeTypeNorm || '').toUpperCase()
        if (existing) {
            existing.count += bundle.weight
            if (existing.edgeTypeNorm !== norm) existing.edgeTypeNorm = ''
            existing.cycleBack = existing.cycleBack || runsBackwards(bundle)
            continue
        }
        byPair.set(id, {
            id,
            source,
            target,
            count: bundle.weight,
            edgeTypeNorm: norm,
            // A wire between two misses is background; one touching a
            // match stays lit, or the filter would hide the answer's own
            // connections.
            dimmed: (byId.get(source)?.dimmed ?? false) && (byId.get(target)?.dimmed ?? false),
            cycleBack: runsBackwards(bundle),
            sourcePort: 0,
            targetPort: 0,
            bundled: false,
            trunkCount: null,
            // Decided from the geometry, below — there is none yet.
            labelVisible: false,
        })
    }
    const edges: FocusEdge[] = [...byPair.values()]

    // ── the OTHER half of the cycle rule: a real directed loop ───────
    //
    // Hop numbering alone cannot see `A → B → A` between two cards at the
    // same hop, and that is exactly what the flatten made common: two
    // tables of one container feeding each other. So the drawn edge set is
    // decomposed into strongly-connected components (Tarjan, iterative —
    // a board is bounded but a recursive walk over it is still a stack
    // this file should not gamble on), and every edge INSIDE a component
    // of more than one card is on a loop by definition.
    //
    // Nothing else stamps a badge: a badge that fires on ordinary forward
    // flow teaches the reader to ignore it, which costs them the one that
    // matters.
    const outgoing = new Map<string, string[]>()
    for (const edge of edges) {
        const list = outgoing.get(edge.source)
        if (list) list.push(edge.target)
        else outgoing.set(edge.source, [edge.target])
    }
    const sccOf = new Map<string, number>()
    {
        const index = new Map<string, number>()
        const low = new Map<string, number>()
        const onStack = new Set<string>()
        const stack: string[] = []
        let counter = 0
        let components = 0
        for (const root of byId.keys()) {
            if (index.has(root)) continue
            // (node, next child to visit)
            const work: Array<{ v: string; i: number }> = [{ v: root, i: 0 }]
            index.set(root, counter)
            low.set(root, counter)
            counter += 1
            stack.push(root)
            onStack.add(root)
            while (work.length > 0) {
                const frame = work[work.length - 1]
                const kids = outgoing.get(frame.v) ?? []
                if (frame.i < kids.length) {
                    const w = kids[frame.i]
                    frame.i += 1
                    if (!index.has(w)) {
                        index.set(w, counter)
                        low.set(w, counter)
                        counter += 1
                        stack.push(w)
                        onStack.add(w)
                        work.push({ v: w, i: 0 })
                    } else if (onStack.has(w)) {
                        low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!))
                    }
                    continue
                }
                work.pop()
                const parentFrame = work[work.length - 1]
                if (parentFrame) {
                    low.set(parentFrame.v, Math.min(low.get(parentFrame.v)!, low.get(frame.v)!))
                }
                if (low.get(frame.v) === index.get(frame.v)) {
                    const id = components++
                    let member: string
                    do {
                        member = stack.pop()!
                        onStack.delete(member)
                        sccOf.set(member, id)
                    } while (member !== frame.v)
                }
            }
        }
    }
    const sccSize = new Map<number, number>()
    for (const id of sccOf.values()) sccSize.set(id, (sccSize.get(id) ?? 0) + 1)
    for (const edge of edges) {
        const component = sccOf.get(edge.source)
        if (component != null && component === sccOf.get(edge.target) && (sccSize.get(component) ?? 0) > 1) {
            edge.cycleBack = true
        }
    }

    // ── 5. GEOMETRY ──────────────────────────────────────────────────

    layoutBands(cards)

    // ── ports: where forty wires actually touch a card ───────────────
    //
    // Every wire used to attach at the middle of a card's edge, so a hub
    // with forty incoming flows drew forty lines converging on one dot —
    // a black wedge with no way to tell which line went where, and no way
    // to point at one.
    //
    // So a card's incident wires are spread evenly down its edge, and the
    // order they are spread in is the order of the FAR ends: wire 1 goes
    // to the topmost neighbour, wire n to the bottom-most. That is what
    // stops two adjacent parallel flows crossing each other between the
    // same pair of columns — the crossing the barycenter pass above
    // cannot reach, because it is inside one card rather than between two.
    //
    // Past `DENSITY_PORTS` there is no spreading left to do: the card is
    // taller than the wires are apart, so that side BUNDLES instead —
    // one trunk out of one port, splitting near the far ends, carrying
    // the summed weight as its label. R5 isolation un-bundles whatever
    // cone the reader points at, which is where the per-wire detail is.
    const centreY = (card: FocusCard) => card.y + card.h / 2
    const incident = (side: 'in' | 'out') => {
        const by = new Map<string, FocusEdge[]>()
        for (const edge of edges) {
            const key = side === 'in' ? edge.target : edge.source
            const list = by.get(key)
            if (list) list.push(edge)
            else by.set(key, [edge])
        }
        return by
    }
    const inByCard = incident('in')
    const outByCard = incident('out')
    for (const card of cards) {
        const ins = inByCard.get(card.id) ?? []
        const outs = outByCard.get(card.id) ?? []
        const wire = (list: FocusEdge[], side: 'in' | 'out'): number => {
            if (list.length === 0) return 0
            // Far end's height decides the order, so parallel flows stay
            // parallel. Tie-broken on the edge id so a build is a function
            // of its input and nothing else.
            const sorted = [...list].sort((a, b) => {
                const fa = byId.get(side === 'in' ? a.source : a.target)
                const fb = byId.get(side === 'in' ? b.source : b.target)
                return (fa ? centreY(fa) : 0) - (fb ? centreY(fb) : 0) || a.id.localeCompare(b.id)
            })
            if (sorted.length > DENSITY_PORTS) {
                for (const edge of sorted) {
                    edge.bundled = true
                    if (side === 'in') edge.targetPort = 0
                    else edge.sourcePort = 0
                }
                // The trunk says what it stands for, ONCE, on the wire
                // running through the middle of the bundle — which is
                // where the trunk is thickest and where a reader looks.
                const carrier = sorted[Math.floor(sorted.length / 2)]
                carrier.trunkCount = sorted.reduce((acc, e) => acc + e.count, 0)
                return 1
            }
            sorted.forEach((edge, i) => {
                if (side === 'in') edge.targetPort = i
                else edge.sourcePort = i
            })
            return sorted.length
        }
        card.portsIn = wire(ins, 'in')
        card.portsOut = wire(outs, 'out')
    }

    // A ×N badge belongs to a wire, so it may only render where the wire
    // can hold one: long enough for a pill, and with nothing already
    // sitting there. Column-to-column lineage draws dozens of short
    // near-parallel hops through one screen, and a badge per hop came out
    // as a drift of pills with no visible owner.
    //
    // Measured between the ports the view actually anchors to (source's
    // right edge, target's left) and at the straight-line midpoint, which
    // is where a shallow bezier puts its label to within a few pixels.
    // A cycle badge is not decided here: it says the lineage LOOPS, which
    // is a fact about the data rather than a count, so density never
    // suppresses it (see the view — which does still require a wire long
    // enough to hold it, by the same `labelFitsRun` this uses).
    const placed: Array<{ x: number; y: number }> = []
    for (const edge of edges) {
        if (edge.count <= 1) continue
        const s = byId.get(edge.source)
        const t = byId.get(edge.target)
        if (!s || !t) continue
        const sx = s.x + s.w
        const sy = s.y + s.h * portFraction(edge.sourcePort, s.portsOut)
        const tx = t.x
        const ty = t.y + t.h * portFraction(edge.targetPort, t.portsIn)
        if (!labelFitsRun(sx, sy, tx, ty)) continue
        const x = (sx + tx) / 2
        const y = (sy + ty) / 2
        if (placed.some(p => Math.abs(p.x - x) < LABEL_W && Math.abs(p.y - y) < LABEL_H)) continue
        placed.push({ x, y })
        edge.labelVisible = true
    }

    // Band headers: how many cards a column holds, and how many raw hops
    // those cards stand for — a frame is one card and eight connections,
    // and a header printing only one of those numbers reads as a lie.
    const bandTotals = new Map<string, { shown: number; total: number; connections: number }>()
    const bandKey = (band: number) => `band:${band < 0 ? 'in' : 'out'}:${Math.abs(band)}`
    for (const card of cards) {
        if (card.frameId || card.band === 0) continue
        const entry = bandTotals.get(bandKey(card.band)) ?? { shown: 0, total: 0, connections: 0 }
        entry.shown += 1
        entry.total += 1
        bandTotals.set(bandKey(card.band), entry)
    }
    const topLevelBandOf = (cardId: string): number => {
        let cursor = byId.get(cardId)
        let guard = 0
        while (cursor?.frameId && guard++ < 32) cursor = byId.get(cursor.frameId)
        return cursor?.band ?? 0
    }
    for (const edge of edges) {
        const a = topLevelBandOf(edge.source)
        const b = topLevelBandOf(edge.target)
        const band = Math.abs(a) >= Math.abs(b) ? a : b
        if (band === 0) continue
        const entry = bandTotals.get(bandKey(band))
        if (entry) entry.connections += edge.count
    }

    /**
     * Does the MODEL know of anything at all on this side — an urn the
     * data source named, a hop it shipped, or a frontier it says is
     * still out there?
     *
     * This, and never an empty BAND, is what may make the "no upstream
     * sources in the data source" claim. The two came apart the moment
     * geometry started moving cards between columns: a shared ancestor
     * swallowed every hop column into band 0, the upstream band came out
     * empty, and the lens whispered that the table had no producers
     * directly above the three producers it was drawing.
     */
    const modelHasSide = (dir: LensDir): boolean => {
        for (const n of model.values()) {
            if (dir === 'in' ? n.up : n.down) return true
            // The focus's own subtree is SEEDED at hop 0, so a hop that
            // genuinely goes somewhere is 1 or more.
            const hop = dir === 'in' ? n.hopUp : n.hopDown
            if (hop != null && hop > 0) return true
        }
        // Nothing in hand — but the data source may still have said there
        // is more that way. The FOCUS's own frontier only: another card's
        // frontier is a statement about that card's side, not this one's.
        for (const urn of subtreeOf(sg.focusUrn)) {
            const entry = dir === 'in' ? model.get(urn)?.frontierUp : model.get(urn)?.frontierDown
            if (entry && (entry.totalCount == null || entry.totalCount > 0 || entry.nextCursor != null)) return true
        }
        return false
    }

    // The frozen slots the NEXT build reads: what earlier builds of this
    // view state drew, plus whatever this one added, in the order it drew
    // them. Append-only, so a card can never be moved by a later merge —
    // and dense, so `size` is always the next free slot.
    const drawnRank = new Map(view.drawnRank)
    let nextRank = drawnRank.size
    for (const card of cards) {
        if (card.nodeId && !drawnRank.has(card.nodeId)) drawnRank.set(card.nodeId, nextRank++)
    }

    return {
        cards,
        edges,
        hiddenByChips,
        hiddenByChipsIn,
        hiddenByChipsOut,
        modelHasUpstream: modelHasSide('in'),
        modelHasDownstream: modelHasSide('out'),
        hopsAtCoarserGrain,
        focusRecovered,
        // Grow-only: what this build walked through, PLUS what earlier
        // builds of the same view state did. The consumer folds it back
        // in (see `LensViewState.walkedThrough`) so a level once seen
        // through stays seen through while the walk grows.
        walkedThrough: new Set([...view.walkedThrough, ...walkedThrough]),
        drawnRank,
        bandTotals,
    }
}

// ── isolation: one element's whole visible lineage ──────────────────

/**
 * Every card and edge on `fromId`'s VISIBLE LINEAGE CONE: everything it
 * feeds, and everything that feeds it, transitively, as far as the
 * picture goes. Pure and client-side: pointing at a card asks nothing of
 * the server, because the answer is already on screen.
 *
 * TWO DIRECTED WALKS, not one undirected one, and the difference is the
 * whole value of the feature. Undirected, every card of a connected board
 * is on every other card's cone — and a lens board is connected by
 * construction, because it is one entity's lineage. Isolating anything
 * would light everything. Directed, `dim_customer`'s SIBLING feeding the
 * same table stays quiet, which is the question a column of forty
 * near-parallel wires actually raises.
 *
 * This is the ONE highlight mechanism (T18 R5). It replaced the
 * path-to-focus highlight, which answered a narrower question — "how does
 * this reach the thing I searched for". The focus is on this cone
 * whenever it is genuinely up- or downstream, so nothing was lost by
 * folding one into the other.
 *
 * Bounded by the BOARD, not by the model: it walks the projected edges,
 * of which there is one per drawn pair whatever the estate weighs.
 * Cycle-safe by the visited set — a directed loop among the drawn cards
 * (which the flatten made ordinary) terminates on the second visit.
 *
 * A `fromId` with no drawn edge at all — a roster extra, a card shown
 * only in "everything inside" — comes back as itself alone, and the
 * caller's contract is that a cone of one card dims nothing: isolating a
 * thing with no lineage would black out the board to say so.
 */
export function isolationCone(
    edges: ReadonlyArray<FocusEdge>,
    fromId: string,
): { edgeKeys: Set<string>; cardIds: Set<string> } {
    const downstream = new Map<string, Array<{ to: string; edgeId: string }>>()
    const upstream = new Map<string, Array<{ to: string; edgeId: string }>>()
    const link = (
        into: Map<string, Array<{ to: string; edgeId: string }>>,
        a: string, b: string, edgeId: string,
    ) => {
        const list = into.get(a)
        if (list) list.push({ to: b, edgeId })
        else into.set(a, [{ to: b, edgeId }])
    }
    for (const e of edges) {
        link(downstream, e.source, e.target, e.id)
        link(upstream, e.target, e.source, e.id)
    }

    const cardIds = new Set<string>([fromId])
    const edgeKeys = new Set<string>()
    const walk = (adjacency: Map<string, Array<{ to: string; edgeId: string }>>) => {
        const seen = new Set<string>([fromId])
        const queue = [fromId]
        for (let i = 0; i < queue.length; i++) {
            for (const { to, edgeId } of adjacency.get(queue[i]) ?? []) {
                edgeKeys.add(edgeId)
                cardIds.add(to)
                if (seen.has(to)) continue
                seen.add(to)
                queue.push(to)
            }
        }
    }
    walk(downstream)
    walk(upstream)
    return { edgeKeys, cardIds }
}

// ── walk export (JSON/CSV) ───────────────────────────────────────────

export interface WalkExportNode {
    urn: string
    name: string
    type: string
    /** Containment parent, null for a top-level card. */
    parentUrn: string | null
    /** Nesting level, 0 for a top-level card — same as `FocusCard.depth`. */
    depth: number
}

export interface WalkExportEdge {
    sourceUrn: string
    targetUrn: string
    /** '' when the bundle carries more than one relationship type. */
    type: string
    weight: number
}

export interface WalkExportPayload {
    focus: string
    generatedAt: string
    nodes: WalkExportNode[]
    edges: WalkExportEdge[]
}

/**
 * The VISIBLE picture (cards + projected bundles, including nesting
 * parent) as portable data. Addressed by urn throughout — never the
 * layout's own card ids — so the export means the same thing outside the
 * lens as it does inside it. No server call: this is a re-projection of
 * `graph`, exactly what is already on screen.
 */
export function buildWalkExport(
    graph: FocusGraph,
    focusUrn: string,
    now: () => string = () => new Date().toISOString(),
): WalkExportPayload {
    const cardById = new Map(graph.cards.map(c => [c.id, c]))
    const nodes: WalkExportNode[] = graph.cards
        .filter(c => c.nodeId !== null)
        .map(c => ({
            urn: c.nodeId!,
            name: c.label,
            type: c.type,
            // The parent IN THIS PICTURE, which is what the rest of the
            // export describes. A card whose container was demoted to a
            // breadcrumb is top-level here, and naming a parent that has
            // no row would leave anyone rebuilding the tree with a
            // dangling id — and contradict `depth`, which already says 0.
            parentUrn: c.frameId === null ? null : c.parentId,
            depth: c.depth,
        }))
    const edges: WalkExportEdge[] = graph.edges.map(e => ({
        sourceUrn: cardById.get(e.source)?.nodeId ?? e.source,
        targetUrn: cardById.get(e.target)?.nodeId ?? e.target,
        type: e.edgeTypeNorm,
        weight: e.count,
    }))
    return { focus: focusUrn, generatedAt: now(), nodes, edges }
}

/** Quote a CSV field only when it needs it (comma, quote or newline),
 *  doubling any interior quotes. `null` renders as an empty field, never
 *  the literal string "null".
 *
 *  A field that OPENS with `= + - @` is a formula to Excel and Sheets,
 *  and these fields are entity names straight from someone's catalogue —
 *  so an export of a lineage picture could execute on the desk of
 *  whoever opened it. A leading apostrophe is the standard defusing: the
 *  spreadsheet shows the text and runs nothing. */
function csvField(v: string | number | null): string {
    // Numbers are never formulas, and a negative depth defused into
    // `'-1` would be a corrupted column, not a safer one.
    if (typeof v === 'number') return String(v)
    const raw = v ?? ''
    const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * One CSV file for the whole export: a nodes table, a blank line, then
 * an edges table — the simplest single-download shape (two files would
 * mean two save-as prompts for one export click; one combined table
 * would mean a stub row per node re-explaining the edge columns). The
 * column headers alone say which table is which.
 */
export function walkExportToCsv(payload: WalkExportPayload): string {
    const nodeRows = [
        'urn,name,type,parentUrn,depth',
        ...payload.nodes.map(n => [n.urn, n.name, n.type, n.parentUrn, n.depth].map(csvField).join(',')),
    ]
    const edgeRows = [
        'sourceUrn,targetUrn,type,weight',
        ...payload.edges.map(e => [e.sourceUrn, e.targetUrn, e.type, e.weight].map(csvField).join(',')),
    ]
    return [...nodeRows, '', ...edgeRows].join('\n')
}
