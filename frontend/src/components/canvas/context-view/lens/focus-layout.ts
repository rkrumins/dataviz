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
    rowHeight,
    ANCESTRY_CAP,
    CARD_H,
    CARD_W,
    CHILD_ROW_H,
    FOCAL_H,
    FRAME_ALL_CAP,
    FRAME_CHILD_CAP,
    UNRESOLVED_TYPE,
    type FocusCard,
    type FocusEdge,
    type FocusGraph,
    type FocusPill,
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

/** How long a drawn bundle must be before it can carry its ×N badge,
 *  and the box that badge occupies — two labels closer than this overlap
 *  into an unreadable smudge, so the second one is not drawn. */
const LABEL_MIN_RUN = 90
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
    frameQueries: ReadonlyMap<string, string>
    framePages: ReadonlyMap<string, number>
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
        frameQueries: new Map(),
        framePages: new Map(),
    }
}

const EMPTY_STRINGS: string[] = []

/** One reveal group: a root-most container of not-yet-shown neighbours,
 *  and the raw hops that reach into it. */
interface RevealGroup {
    root: string
    weight: number
    members: string[]
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
    /** Containment ancestors, ROOT-FIRST, capped like the old builder's
     *  provenance ribbon. */
    const ancestorsOf = (urn: string): string[] => {
        const hit = ancestorCache.get(urn)
        if (hit) return hit
        const out: string[] = []
        const seen = new Set<string>([urn])
        let cursor = model.get(urn)?.parent ?? null
        while (cursor && !seen.has(cursor) && out.length < ANCESTRY_CAP) {
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
     * `near` is which nodes the question is asked FROM; `inside` is the
     * card's whole subtree and decides what counts as INTERNAL. They are
     * separate parameters on purpose: the pill asks from what a card
     * visually stands for, the click acts on the card's whole subtree,
     * and if the internal test moved with `near` the two would disagree
     * about a hop that leaves a collapsed sibling — a pill offering
     * something the click could not deliver. Keeping `inside` fixed makes
     * what the pill offers a SUBSET of what the click admits, always.
     */
    const groupsFrom = (
        dir: LensDir,
        near: ReadonlySet<string>,
        inside: ReadonlySet<string>,
        cacheKey: string,
    ): RevealGroup[] => {
        const hit = groupCache.get(cacheKey)
        if (hit) return hit
        const byRoot = new Map<string, { weight: number; members: Set<string> }>()
        for (const hop of sg.lineageEdges) {
            const from = dir === 'in' ? hop.targetUrn : hop.sourceUrn
            const far = dir === 'in' ? hop.sourceUrn : hop.targetUrn
            if (!near.has(from) || inside.has(far) || seed.has(far)) continue
            const root = rootOf(far)
            const group = byRoot.get(root) ?? { weight: 0, members: new Set<string>() }
            group.weight += 1
            group.members.add(far)
            byRoot.set(root, group)
        }
        const ranked = [...byRoot.entries()]
            .map(([root, g]) => ({ root, weight: g.weight, members: [...g.members].sort() }))
            .sort((a, b) =>
                b.weight - a.weight
                || labelFor(a.root).localeCompare(labelFor(b.root))
                || a.root.localeCompare(b.root))
        groupCache.set(cacheKey, ranked)
        return ranked
    }
    /** What a REVEAL CLICK on this card admits: everything reachable from
     *  its whole subtree, whatever is currently open. */
    const rankedGroups = (dir: LensDir, urn: string): RevealGroup[] =>
        groupsFrom(dir, subtreeOf(urn), subtreeOf(urn), `sub:${dir}:${urn}`)

    const revealedKeys = [...view.revealed.keys()].sort()
    const admittedGroups: RevealGroup[] = []
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
                if (!admittedGroups.some(g => g.root === group.root)) admittedGroups.push(group)
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

    // ── 2. ANSWER GRAIN ──────────────────────────────────────────────

    const childrenInPopulation = (urn: string): string[] =>
        (nodeOf(urn)?.children ?? []).filter(c => population.has(c))

    /** The containment chain above the focus. Never geometry (see the
     *  frame pass below), so it is never an answer grain either. */
    const focusAncestors = new Set(ancestorsOf(sg.focusUrn))

    /** Entities the data source itself put on a hop. They are what the
     *  picture is OF at their grain, so the answer walk never sees
     *  through one — and, because the walk stops there, no skipped level
     *  can ever be carrying a wire when it is dropped from the geometry. */
    const carriesHop = new Set<string>()
    for (const hop of sg.lineageEdges) {
        if (!population.has(hop.sourceUrn) || !population.has(hop.targetUrn)) continue
        carriesHop.add(hop.sourceUrn)
        carriesHop.add(hop.targetUrn)
    }

    /** A hop that ends on a LEAF: the data source named it, and there is
     *  nothing inside it to open. It belongs in its owner's frame as a
     *  ROW — that is what a table full of connected columns looks like —
     *  rather than as a card of its own. A hop-carrier that HOLDS things
     *  is its own card, because it has an inside to show. */
    const isLeafHopCarrier = (urn: string): boolean =>
        carriesHop.has(urn) && (nodeOf(urn)?.children.length ?? 0) === 0

    /** Levels the layout opens by itself, and — of those — the ones it
     *  opens WITHOUT drawing, because they are chrome the answer sits
     *  under. Separate sets: a container holding rows is opened AND
     *  drawn; a level walked past is opened and not. */
    const spine = new Set<string>()
    const walkedThrough = new Set<string>()
    const spineSeen = new Set<string>()
    const openThrough = (urn: string) => {
        if (spineSeen.has(urn) || !population.has(urn)) return
        spineSeen.add(urn)
        const kids = childrenInPopulation(urn)
        if (kids.length === 0) return
        // THE FOCUS IS NEVER CHROME. It is the thing you asked about: it
        // always gets its card and its contains-stack, whatever its shape
        // happens to be. (A focus with exactly one connected child and no
        // hop of its own used to satisfy the pass-through test below,
        // join the spine, and be demoted out of the picture — leaving a
        // board with no focal card and, because every hop reprojects onto
        // it, no wires at all.)
        if (urn === sg.focusUrn) return
        const above = focusAncestors.has(urn)
        // The grain the answer is PRESENTED at: a container holding hops
        // that end in it is what the picture is of. Open it so its rows
        // show — `int_clean_orders_t1` with its connected columns in it,
        // counted, searchable and paged in place — and draw it. Never
        // above the focus, where nothing is drawn at all (R1).
        if (!above && kids.some(isLeafHopCarrier)) { spine.add(urn); return }
        // Otherwise chrome, and seen through: a level above the focus, or
        // a PASS-THROUGH the data source has not itself named as a
        // lineage end. Sticky, because the population only grows: a level
        // once drawn through stays drawn through for this view state, or
        // the arrival of a second child would turn it into a card and
        // swallow the one already on the board.
        if (above || view.walkedThrough.has(urn) || (kids.length === 1 && !carriesHop.has(urn))) {
            spine.add(urn)
            walkedThrough.add(urn)
            for (const kid of kids) openThrough(kid)
        }
    }
    for (const group of admittedGroups) openThrough(group.root)

    const expanded = new Set<string>([...view.expandedContainment, ...spine])
    for (const urn of view.collapsedContainment) expanded.delete(urn)

    // ── 3. VISIBILITY ────────────────────────────────────────────────

    // Pre-order, parents before children: `visibleLensNodes` stops at any
    // closed node, which IS the "every ancestor must be open" rule, and
    // the population is ancestor-closed so nothing is stranded.
    const visibleOrder = visibleLensNodes(sg, expanded).filter(u => population.has(u))
    const visible = new Set(visibleOrder)

    /**
     * What is INSIDE the focus is contents, not board geometry.
     *
     * The focus is one compact card with one port a side, and the
     * contains-stack under it says what it holds. So its descendants are
     * drawn as rows there, but they are not WIRED: every hop into or out
     * of the focus's subtree is the focus's own lineage and lands on the
     * focal card, where a reader can follow it. Bundling by the shared
     * endpoint is what turns eight column-to-column arcs into eight
     * wires converging on one port, with no edge router involved.
     *
     * Everything below reads `wired` where it means "an end a hop can
     * land on" and `visible` where it means "a card on the board".
     */
    const focusContents = new Set(subtreeOf(sg.focusUrn))
    focusContents.delete(sg.focusUrn)
    const wired = new Set([...visibleOrder].filter(u => !focusContents.has(u)))
    const projected = projectLensEdges(sg, population, wired)

    /**
     * What each wired card VISUALLY STANDS FOR: itself, plus every
     * population member whose nearest wired ancestor it is.
     *
     * This is the same rule `projectLensEdges` uses to decide where a
     * hop lands, applied to the ⊕ — and it has to be, or a frontier gets
     * reported once per containment level above it. Five nested frames
     * each grew their own copy of one column's "+2", four of which could
     * not be acted on separately and which piled up on top of each other
     * in the gutter. A card offers exactly what it stands for — and the
     * focal, standing for its whole subtree, offers the table's frontier
     * once rather than once per column.
     */
    const standsFor = new Map<string, Set<string>>()
    for (const urn of wired) standsFor.set(urn, new Set([urn]))
    for (const urn of population) {
        if (wired.has(urn)) continue
        let cursor: string | null = model.get(urn)?.parent ?? null
        const guard = new Set<string>()
        while (cursor && !guard.has(cursor)) {
            if (wired.has(cursor)) { standsFor.get(cursor)!.add(urn); break }
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

    // ── 3b. NO PASSIVE WRAPPERS ──────────────────────────────────────
    //
    // A container the picture merely SAW THROUGH on its way to the
    // answer is not geometry. Nothing is a frame for having been walked
    // past: a frame means "this entity, opened", and the only two ways
    // to get one are to BE the presented grain of a group (and be
    // opened) or to be a container someone opened inside such a frame.
    //
    // Reported live: focusing REPORTING — a container inside the
    // platform Snowflake — whose sources GOLD and INTERMEDIATE_T2 live
    // in that SAME platform drew one Snowflake frame holding the focus
    // and both sources stacked under it. No left-to-right flow, every
    // wire looping back through the box, and an upstream band so empty
    // it whispered "no upstream sources" over a picture full of them.
    // Boxing a single group is the same mistake in miniature — it spends
    // ~90px of chrome per level to say what one line of breadcrumb says.
    //
    // So a visible container is DEMOTED — no card at all, its children
    // promoted to the top level of their own hop columns, each carrying
    // the ancestry it came from — when it is:
    //
    //   • ABOVE THE FOCUS. The thing you asked about anchors the picture
    //     and is never enclosed by anything; what is above it is the
    //     focal breadcrumb. (Its own contents are stated by the
    //     contains-stack attached below the focal — see `emit`.)
    //   • WALKED THROUGH by the answer grain. `walkedThrough` is exactly
    //     the levels the walk saw past on its way to the answer, so they
    //     are chrome by construction; the level the answer is presented
    //     at is opened but never in it.
    //
    // Both cases are ancestor-closed (every ancestor of a focus-ancestor
    // is one; every ancestor of a walked-through level was walked through
    // to get there), so the demoted set is a prefix from the roots:
    // nothing nested inside a surviving frame is ever demoted, and the
    // cascade is just "keep walking down until something survives".
    //
    // A demoted level can never be carrying a wire: the grain walk stops
    // at any entity the data source put on a hop (`carriesHop`), so a
    // walked-through level has none — and a hop that ends on a focus
    // ancestor is the one shape this rule cannot draw, which the focal
    // says out loud rather than dropping in silence (see below).
    const visibleChildrenOf = (urn: string): string[] =>
        (nodeOf(urn)?.children ?? []).filter(c => visible.has(c))

    const demoted = new Set<string>()
    for (const urn of visibleOrder) {
        // Nothing is enclosed, so there is no wrapper to remove: a card
        // with its contents shut stands for what is inside it, which is
        // its job. And never the focus, whatever its shape.
        if (urn === sg.focusUrn || visibleChildrenOf(urn).length === 0) continue
        if (focusAncestors.has(urn) || walkedThrough.has(urn)) demoted.add(urn)
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
            cursor = visibleChildrenOf(cursor)[0] ?? null
        }
        return cursor
    }
    for (const urn of demoted) {
        const node = model.get(urn)
        if (!node?.frontierUp && !node?.frontierDown) continue
        const host = focusAncestors.has(urn) ? sg.focusUrn : unitUnder(urn)
        if (!host || host === urn) continue
        const folded = foldedFrontiers.get(host) ?? new Set<string>()
        folded.add(urn)
        foldedFrontiers.set(host, folded)
    }

    /** The cards that get a hop column of their own: every model root,
     *  and — through each demoted container — the groups it held. */
    const topLevelUnits: string[] = []
    const unitGuard = new Set<string>()
    const collectUnits = (urn: string) => {
        if (unitGuard.has(urn)) return
        unitGuard.add(urn)
        if (!demoted.has(urn)) { topLevelUnits.push(urn); return }
        for (const kid of visibleChildrenOf(urn)) collectUnits(kid)
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
    const rankCards = (urns: string[]): string[] =>
        [...urns].sort((a, b) =>
            weightOf(b) - weightOf(a)
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
    const pillFor = (urn: string, dir: LensDir): FocusPill | null => {
        const owned = ownedBy(urn)
        // What this direction could still show from data already in hand:
        // the REMAINDER, not one page of it. A group another card's reveal
        // already put on the board is not offered again, and — because the
        // admission loop charges a page only for what it introduces — every
        // group counted here is one a click can actually reach.
        const remainingGroups = groupsFrom(dir, owned, subtreeOf(urn), `own:${dir}:${urn}`)
            .filter(g => g.members.some(m => !population.has(m)))
        if (remainingGroups.length > 0) {
            return {
                kind: 'reveal',
                count: remainingGroups.length,
                key: revealKey(dir, urn),
                cursor: undefined,
                status: undefined,
            }
        }
        // The card speaks for what it stands for — its own frontier, plus
        // that of anything collapsed inside it, plus that of any level
        // the picture walked THROUGH to present this card.
        const entries = [...owned, ...(foldedFrontiers.get(urn) ?? [])]
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
        description: null,
        parentId: null, parentLabel: null,
        count: 1, edgeTypeNorm: '',
        frameId: null, depth: 0,
        ancestry: EMPTY_STRINGS, ancestryIds: EMPTY_STRINGS,
        frameEmpty: false,
        connected: true, frameShowingAll: false, frameConnectedCount: 0,
        frameLoaded: 0, frameTotal: -1, frameHasMore: false,
        frameSharedEdgeType: '',
        framePage: 0, framePageSize: FRAME_CHILD_CAP,
        canOpenChildren: false, childrenOpen: false,
        expandKey: null, expanded: false, deadEnd: false,
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
        const kids = rankCards((nodeOf(urn)?.children ?? []).filter(c => visible.has(c)))
        const showAll = view.frameShowAll.has(urn)
        const isFocus = urn === sg.focusUrn
        const label = labelFor(urn)
        const ancestry = ancestorsOf(urn)
        const parent = nodeOf(urn)?.parent ?? null

        const roster = childrenAll.get(urn)
        const rosterExtras = showAll
            ? (roster?.children ?? [])
                .map(n => n.id)
                .filter(id => !visible.has(id) && !cardIdByUrn.has(id))
            : []
        const rows = [...kids, ...rosterExtras]
        // The FOCUS is always a compact card. What it holds is stated by
        // the contains-stack attached below it (further down), never by
        // swelling the thing you asked about into a frame the rest of the
        // board sits beside.
        const isFrame = rows.length > 0 && !isFocus
        // A row of the contains-stack is CONTENTS. Its lineage is the
        // focus's lineage — drawn at the focal, offered by the focal's ⊕
        // — so a row neither carries a pill of its own nor gets to claim
        // that the walk ended at it.
        const { pillUp, pillDown, deadEnd } = focusContents.has(urn)
            ? { pillUp: null, pillDown: null, deadEnd: false }
            : walkStateOf(urn, isFrame, band)
        const pageSize = showAll ? FRAME_ALL_CAP : FRAME_CHILD_CAP
        const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
        const page = Math.min(Math.max(0, view.framePages.get(urn) ?? 0), pageCount - 1)
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
            type: typeFor(urn),
            frameId: hostFrameId,
            parentId: parent,
            parentLabel: parent ? labelFor(parent) : null,
            ancestry: ancestry.map(labelFor),
            ancestryIds: ancestry,
            count: Math.max(1, weightOf(urn)),
            canOpenChildren: (nodeOf(urn)?.children.length ?? 0) > 0,
            childrenOpen: isFrame,
            expandKey: urn,
            expanded: isFrame,
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
            frameConnectedCount: kids.length,
            frameLoaded: showAll ? rows.length : kids.length,
            frameTotal: showAll ? (roster?.total ?? -1) : (contentsOf(urn)?.total ?? -1),
            frameHasMore: showAll ? (roster?.hasMore ?? false) : false,
            framePage: page,
            framePageSize: pageSize,
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
                label: 'Contains',
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
                // The walk's own ⊕ belongs to the focal card, once.
                pillUp: null,
                pillDown: null,
                deadEnd: false,
                dimmed: false,
                fetch: showAll && childrenAllStatus.get(urn) === 'loading' ? 'loading'
                    : showAll && childrenAllStatus.get(urn) === 'error' ? 'error'
                        : null,
            }
            pushCard(host)
        } else if (!isFrame) return

        // ONE fixed window of rows, so a 500-column table and a 5-column
        // one occupy the same room and a page click moves the window
        // rather than growing the frame.
        for (const child of rows.slice(page * pageSize, page * pageSize + pageSize)) {
            if (visible.has(child)) {
                emit(child, host.id, depth + 1, band, frameQuery)
                continue
            }
            // Inside this, but off the lineage. Only ever shown in "All",
            // and marked, because it must never read as a connection.
            const node = (roster?.children ?? []).find(n => n.id === child)
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

    // Column order, then rank inside the column: the heaviest source sits
    // at the top of its band — except in band 0, which the focus always
    // leads, because `layoutBands` centers that band's first card on the
    // midline and the thing you asked about is what the midline is for.
    const units = rankCards(topLevelUnits).sort((a, b) =>
        signedHop(a) - signedHop(b)
        || Number(b === sg.focusUrn) - Number(a === sg.focusUrn))
    for (const unit of units) {
        const band = signedHop(unit)
        // The whole band a direction filter hides — never emitted, so its
        // cards, pills AND edges (an edge needs both endpoints' card ids)
        // are all absent at once. Band 0 (the focus's own subtree) is
        // never a "side" and is never skipped.
        if (directionFilter === 'in' && band > 0) continue
        if (directionFilter === 'out' && band < 0) continue
        emit(unit, null, 0, band)
    }

    // A frame states its rows' one shared relationship, and that decides
    // the ROW HEIGHT — a row with nothing to put in a subtitle is 36px,
    // not 64. Decided here so the view can never suppress what the layout
    // reserved room for.
    const byId = new Map(cards.map(c => [c.id, c]))
    for (const card of cards) {
        if (card.kind !== 'frame') continue
        const rows = cards.filter(c => c.frameId === card.id && c.connected)
        const types = rows.map(r => edgeTypeOf(r.id))
        card.frameSharedEdgeType = types.length > 0 && types.every(t => t === types[0]) ? types[0] : ''
    }
    for (const card of cards) {
        if (!card.frameId || !card.connected) continue
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

    /** A hop that goes BACKWARDS in the picture's own hop numbering
     *  closes a cycle: `B → A` where A is nearer the focus than B on the
     *  same side. Stated per-direction because a node can legitimately
     *  sit on both sides of a diamond without any cycle existing. */
    const closesCycle = (bundle: ProjectedLensEdge): boolean => {
        const s = hopsOf(bundle.sourceUrn)
        const t = hopsOf(bundle.targetUrn)
        if (s.down != null && t.down != null && t.down <= s.down) return true
        if (s.up != null && t.up != null && s.up <= t.up) return true
        return false
    }

    const edges: FocusEdge[] = []
    // Hops whose nearest drawn end is a level this picture does not draw
    // — a containment ancestor of the FOCUS that the data source also
    // put on a hop. There is no card to land them on, so they are said
    // out loud on the focal instead of vanishing, and the partner at the
    // far end keeps a card with no wire that the whisper explains.
    let hopsAtCoarserGrain = 0
    for (const bundle of projected) {
        const source = cardIdByUrn.get(bundle.sourceUrn)
        const target = cardIdByUrn.get(bundle.targetUrn)
        if (!source || !target) { hopsAtCoarserGrain += bundle.weight; continue }
        edges.push({
            id: `e:${source}>${target}`,
            source,
            target,
            count: bundle.weight,
            edgeTypeNorm: (bundle.edgeTypeNorm || '').toUpperCase(),
            // A wire between two misses is background; one touching a
            // match stays lit, or the filter would hide the answer's own
            // connections.
            dimmed: (byId.get(source)?.dimmed ?? false) && (byId.get(target)?.dimmed ?? false),
            cycleBack: closesCycle(bundle),
            // Decided from the geometry, below — there is none yet.
            labelVisible: false,
        })
    }

    // ── 5. GEOMETRY ──────────────────────────────────────────────────

    layoutBands(cards)

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
    // is a fact about the data rather than a count, so it renders on its
    // wire whatever the density (see the view).
    const placed: Array<{ x: number; y: number }> = []
    for (const edge of edges) {
        if (edge.count <= 1) continue
        const s = byId.get(edge.source)
        const t = byId.get(edge.target)
        if (!s || !t) continue
        const sx = s.x + s.w
        const sy = s.y + s.h / 2
        const tx = t.x
        const ty = t.y + t.h / 2
        if (Math.hypot(tx - sx, ty - sy) < LABEL_MIN_RUN) continue
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

    return {
        cards,
        edges,
        hiddenByChips,
        hiddenByChipsIn,
        hiddenByChipsOut,
        modelHasUpstream: modelHasSide('in'),
        modelHasDownstream: modelHasSide('out'),
        hopsAtCoarserGrain,
        // Grow-only: what this build walked through, PLUS what earlier
        // builds of the same view state did. The consumer folds it back
        // in (see `LensViewState.walkedThrough`) so a level once seen
        // through stays seen through while the walk grows.
        walkedThrough: new Set([...view.walkedThrough, ...walkedThrough]),
        bandTotals,
    }
}

// ── path-to-focus highlight ─────────────────────────────────────────

/**
 * Every card and edge on SOME shortest path between `fromId` and
 * `focalId`, computed over the PROJECTED edges (`FocusGraph.edges`) —
 * both orientations, so a wire drawn the other way still counts. Pure
 * and client-side: hovering or selecting a card asks nothing of the
 * server, because the answer is already sitting in the picture.
 *
 * "Some" rather than "the" on purpose — a diamond (two branches of equal
 * length rejoining before the focus) highlights BOTH branches, not one
 * arbitrarily chosen. Cycle-safe: BFS distance is computed once, and the
 * backtrack only ever walks strictly toward the focus, so a loop in the
 * projected edges cannot make it retrace its steps.
 *
 * `fromId === focalId` (hovering the focus itself) and a `fromId` with
 * no route to the focus at all (a roster extra — a card shown only in
 * "everything inside" mode, off the lineage) both return empty sets: the
 * caller's contract is that an empty result means "nothing dims".
 */
export function pathToFocus(
    edges: ReadonlyArray<FocusEdge>,
    fromId: string,
    focalId: string,
): { edgeKeys: Set<string>; cardIds: Set<string> } {
    if (fromId === focalId) return { edgeKeys: new Set(), cardIds: new Set() }

    const adjacency = new Map<string, Array<{ to: string; edgeId: string }>>()
    const link = (a: string, b: string, edgeId: string) => {
        const list = adjacency.get(a)
        if (list) list.push({ to: b, edgeId })
        else adjacency.set(a, [{ to: b, edgeId }])
    }
    for (const e of edges) {
        link(e.source, e.target, e.id)
        link(e.target, e.source, e.id)
    }

    // BFS distance FROM THE FOCUS, so every node's distance is measured
    // the same way regardless of which card is hovered.
    const dist = new Map<string, number>([[focalId, 0]])
    const queue = [focalId]
    for (let i = 0; i < queue.length; i++) {
        const u = queue[i]
        const du = dist.get(u)!
        for (const { to } of adjacency.get(u) ?? []) {
            if (dist.has(to)) continue
            dist.set(to, du + 1)
            queue.push(to)
        }
    }
    if (!dist.has(fromId)) return { edgeKeys: new Set(), cardIds: new Set() }

    // Backtrack: every edge whose far end is exactly one step closer to
    // the focus than its near end sits on SOME shortest path — multiple
    // qualifying edges at one node is exactly the diamond case.
    const cardIds = new Set<string>([fromId])
    const edgeKeys = new Set<string>()
    const seen = new Set<string>([fromId])
    const stack = [fromId]
    while (stack.length > 0) {
        const u = stack.pop()!
        const du = dist.get(u)!
        if (du === 0) continue   // reached the focus
        for (const { to, edgeId } of adjacency.get(u) ?? []) {
            if (dist.get(to) !== du - 1) continue
            edgeKeys.add(edgeId)
            cardIds.add(to)
            if (!seen.has(to)) { seen.add(to); stack.push(to) }
        }
    }
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
