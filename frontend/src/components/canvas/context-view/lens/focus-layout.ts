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
    assignLanes,
    flowOrder,
    gutterWidth,
    LANE_GAP,
    LANE_W,
    type InternalEdgeRef,
} from './frame-flow'
import {
    labelOf,
    layoutBands,
    rowHeight,
    ANCESTRY_CAP,
    labelFitsRun,
    CARD_H,
    CARD_W,
    CHILD_ROW_H,
    DIVIDER_ROW_H,
    FOCAL_H,
    FRAME_PAD,
    nameLinesFor,
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
    /** T23 R3 — entities the reader placed on the board from a hub
     *  triage list. Admitted into the population OUTSIDE the reveal-page
     *  budget/rank order (see the population stage below): a triage pick
     *  is a specific, deliberate choice, not a page of whatever ranks
     *  highest. Grow-only for this view state's lifetime, same as every
     *  other placement here. */
    pinned: ReadonlySet<string>
    /** T23 R2 — connector ids (see `condensation.ts`) the reader has
     *  explicitly unfolded; every OTHER maximal pass-through run stays
     *  condensed by default. Sticky per view state, like everything else
     *  here — re-centering starts clean. */
    condensedOpen: ReadonlySet<string>
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

/** Every focal-transition kind the lens recognizes (T26 R1). All five
 *  non-restore kinds are proven (T25-C2) to behave IDENTICALLY — a full
 *  reset, atomically, as `LensViewState`'s own reset value — so they are
 *  kept distinct here for auditability and future divergence, not
 *  because today's behaviour differs per kind. `'lens-open'` is the
 *  first-ever focal of a session; `'share-restore'` is the one kind
 *  that SURVIVES fields from a shared link instead of resetting them. */
export type LensViewTransitionKind =
    'reanchor' | 'back' | 'forward' | 'path-jump' | 'share-restore' | 'lens-open'

/** The subset of a restored share link's fields that seed `LensViewState`
 *  on a `'share-restore'` transition — structurally typed (not imported
 *  from `LineageLens.tsx`'s `LensWalkSeed`) so this module stays a pure,
 *  dependency-free layout module; `LensWalkSeed` satisfies this shape. */
export interface LensViewSeed {
    revealed: ReadonlyArray<[string, number]>
    opened: ReadonlyArray<string>
    collapsed: ReadonlyArray<string>
    frameAll: ReadonlyArray<string>
    frameQueries: ReadonlyArray<[string, string]>
    framePages: ReadonlyArray<[string, number]>
    pinned: ReadonlyArray<string>
    condensedOpen: ReadonlyArray<string>
}

/**
 * THE single owner of what a focal transition does to `LensViewState` —
 * every field explicitly RESET (fresh default), or (for `'share-restore'`
 * only) carried to SURVIVE from the shared link. Nothing else in the lens
 * may build a `LensViewState` for a transition; `initialLensViewState`
 * below and every transition call site in `LineageLens.tsx` route
 * through this.
 *
 * `prev` is accepted for symmetry with a kind that might one day carry
 * something forward mid-session; no kind today reads it — the T25-C2
 * finding is that a focal transition starts every field completely
 * fresh, which is what makes the reset safe to compute as a pure,
 * atomic value rather than a stateful effect (see `LineageLens.tsx`'s
 * `view` derivation).
 */
export function viewStateForTransition(
    kind: LensViewTransitionKind,
    _prev: LensViewState | null,
    nextFocal: { sg: LensSubgraph<LensWalkNode>; seed?: LensViewSeed | null },
    /** The header's Contents preference. 'all' seeds `frameShowAll` with
     *  the FOCAL, so a focused container opens showing its whole roster
     *  rather than only the flow-participating rows ("I focused it — show
     *  me everything it holds", 2026-08-19 ruling). Share-restore ignores
     *  it: a link replays ITS OWN picture. */
    frameChildrenMode: 'connected' | 'all' = 'connected',
): LensViewState {
    const fresh: LensViewState = {
        selection: null,
        revealed: new Map([
            [revealKey('in', nextFocal.sg.focusUrn), 1],
            [revealKey('out', nextFocal.sg.focusUrn), 1],
        ]),
        expandedContainment: new Set([...focusAncestorChain(nextFocal.sg), nextFocal.sg.focusUrn]),
        collapsedContainment: new Set(),
        frameShowAll: new Set(frameChildrenMode === 'all' ? [nextFocal.sg.focusUrn] : []),
        walkedThrough: new Set(),
        drawnRank: new Map(),
        frameQueries: new Map(),
        frameOffsets: new Map(),
        pinned: new Set(),
        condensedOpen: new Set(),
    }
    switch (kind) {
        case 'reanchor':
        case 'back':
        case 'forward':
        case 'path-jump':
        case 'lens-open':
            // Every field RESET.
            return fresh
        case 'share-restore': {
            const seed = nextFocal.seed
            if (!seed) return fresh
            return {
                selection: fresh.selection, // RESET — a restored link never re-opens a selection
                revealed: new Map(seed.revealed), // SURVIVE
                expandedContainment: new Set(seed.opened), // SURVIVE
                collapsedContainment: new Set(seed.collapsed), // SURVIVE
                frameShowAll: new Set(seed.frameAll), // SURVIVE
                // Not carried in a link: the grain a shared picture is
                // drawn at, and the slots its cards hold, are both
                // re-derived from the model the link replays.
                walkedThrough: fresh.walkedThrough, // RESET
                drawnRank: fresh.drawnRank, // RESET
                frameQueries: new Map(seed.frameQueries), // SURVIVE
                frameOffsets: new Map(seed.framePages), // SURVIVE
                pinned: new Set(seed.pinned), // SURVIVE
                condensedOpen: new Set(seed.condensedOpen), // SURVIVE
            }
        }
    }
}

/**
 * Where a walk starts: one page of neighbours in each direction, and the
 * containment spine down to the focus already open, so the focus is on
 * the board the moment the walk lands rather than buried inside a
 * container the user has to go hunting for.
 */
export function initialLensViewState(sg: LensSubgraph<LensWalkNode>): LensViewState {
    return viewStateForTransition('lens-open', null, { sg })
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

/**
 * Which drawn cards can reach each OTHER — the bounded "is this wire on a
 * directed loop" check the cycle badge rests on, as a card id → component
 * id map.
 *
 * Only components of MORE THAN ONE card are recorded: a lone card is
 * trivially its own component and says nothing about looping, and the
 * board never draws a wire from a card to itself (`byPair` above drops
 * both self-pairs and pairs where one end contains the other). So two
 * ends sharing a component is exactly "there is a directed path back".
 *
 * Iterative Tarjan. A lens board can carry a few thousand cards and
 * lineage is chain-shaped, which is precisely the input the textbook
 * recursive walk overflows the JS stack on.
 */
function sameComponent(edges: ReadonlyArray<FocusEdge>): Map<string, number> {
    const adjacency = new Map<string, string[]>()
    for (const e of edges) {
        const list = adjacency.get(e.source)
        if (list) list.push(e.target)
        else adjacency.set(e.source, [e.target])
        if (!adjacency.has(e.target)) adjacency.set(e.target, [])
    }

    const index = new Map<string, number>()
    const low = new Map<string, number>()
    const onStack = new Set<string>()
    const stack: string[] = []
    const component = new Map<string, number>()
    let next = 0
    let components = 0

    const open = (node: string) => {
        index.set(node, next)
        low.set(node, next)
        next += 1
        stack.push(node)
        onStack.add(node)
    }

    for (const root of adjacency.keys()) {
        if (index.has(root)) continue
        open(root)
        // One frame per node on the walk: which node, and how far through
        // its neighbours we have got.
        const work: Array<{ node: string; at: number }> = [{ node: root, at: 0 }]
        while (work.length > 0) {
            const frame = work[work.length - 1]
            const neighbours = adjacency.get(frame.node)!
            if (frame.at < neighbours.length) {
                const to = neighbours[frame.at]
                frame.at += 1
                if (!index.has(to)) {
                    open(to)
                    work.push({ node: to, at: 0 })
                } else if (onStack.has(to)) {
                    low.set(frame.node, Math.min(low.get(frame.node)!, index.get(to)!))
                }
                continue
            }
            work.pop()
            const parent = work[work.length - 1]
            if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!))
            if (low.get(frame.node) !== index.get(frame.node)) continue
            const members: string[] = []
            for (;;) {
                const member = stack.pop()!
                onStack.delete(member)
                members.push(member)
                if (member === frame.node) break
            }
            if (members.length > 1) {
                const id = components
                components += 1
                for (const member of members) component.set(member, id)
            }
        }
    }
    return component
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

    // T23 R3 — a triage-list PLACEMENT: admit this urn regardless of
    // group rank or reveal budget. A pick from the list is a specific,
    // deliberate choice ("place THIS one"), not a page of whatever ranks
    // highest — `admit` already closes over containment ancestors, so a
    // pinned entity reaches the board through its own container exactly
    // the way any other admission does, and becomes a full citizen of
    // everything downstream (weight, rank, wires, Reach).
    for (const urn of view.pinned) admit(urn)

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

    /** What is INSIDE the focus: its contains-stack rows. */
    const focusContents = new Set(subtreeOf(sg.focusUrn))
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
     * AND THE FOCUS'S OWN CONTENTS ARE NO EXCEPTION. A hop with both
     * ends inside the focus used to be dropped here — at the time the
     * contains-stack had no route between its own rows, so the wire left
     * the stack and came back in ("the tower in miniature"). In-frame
     * lanes gave every container a way to draw its internal lineage
     * without crossing a card, and the focus is a row-holding card like
     * any other, so it now draws its own the same way. Reported live:
     * focusing Snowflake showed five layers and not one wire between
     * them, while the canvas behind showed them feeding each other.
     */
    const wired = new Set(visibleOrder)
    const projected = projectLensEdges(sg, population, wired)

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

    /**
     * WHICH ROW OF `frameUrn` SPEAKS FOR THIS ENDPOINT — the child of
     * that container the endpoint is, or sits inside. Null when the
     * endpoint is outside it entirely.
     *
     * A hop inside an opened warehouse can name a COLUMN two levels
     * down; the frame's own arrangement is about its rows, so the hop is
     * asked which row it enters and leaves by, never at what depth.
     */
    const rowUnder = (frameUrn: string, endpoint: string): string | null => {
        let cursor: string | null = endpoint
        const guard = new Set<string>()
        while (cursor && !guard.has(cursor)) {
            const parent: string | null = model.get(cursor)?.parent ?? null
            if (parent === frameUrn) return cursor
            guard.add(cursor)
            cursor = parent
        }
        return null
    }

    /**
     * The lineage that stays INSIDE a container, stated in its own rows —
     * what `frame-flow` arranges the rows by and routes through the
     * gutter. Deduped by row pair: two columns of one table feeding two
     * columns of another is ONE flow between those two rows, which is
     * what the reader sees and what the lane allocator must budget for.
     */
    const internalHopsCache = new Map<string, InternalEdgeRef[]>()
    const internalHopsOf = (frameUrn: string): InternalEdgeRef[] => {
        const hit = internalHopsCache.get(frameUrn)
        if (hit) return hit
        const out: InternalEdgeRef[] = []
        const seen = new Set<string>()
        for (const hop of projected) {
            const s = rowUnder(frameUrn, hop.sourceUrn)
            const t = rowUnder(frameUrn, hop.targetUrn)
            if (!s || !t || s === t) continue
            const id = `${s}>${t}`
            if (seen.has(id)) continue
            seen.add(id)
            out.push({ id, source: s, target: t })
        }
        internalHopsCache.set(frameUrn, out)
        return out
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
    /**
     * `weightOf` split by direction — the hops crossing this card's own
     * subtree boundary, counted as arriving or leaving.
     *
     * THE SAME RULE THE WIRES OBEY, which is the whole point: a card's
     * stated connection count and the lines attached to it are two
     * renderings of one fact, and reading it off the entity's OWN raw
     * degree instead is what put "0 in · 0 out" on a table with wires on
     * both sides (its columns carry the lineage; the table itself has
     * none of its own).
     */
    const crossCache = new Map<string, { in: number; out: number }>()
    const crossingOf = (urn: string): { in: number; out: number } => {
        const hit = crossCache.get(urn)
        if (hit) return hit
        const sub = subtreeOf(urn)
        let arrives = 0
        let leaves = 0
        for (const hop of sg.lineageEdges) {
            if (!population.has(hop.sourceUrn) || !population.has(hop.targetUrn)) continue
            const from = sub.has(hop.sourceUrn)
            const to = sub.has(hop.targetUrn)
            if (from === to) continue
            if (to) arrives += 1
            else leaves += 1
        }
        const out = { in: arrives, out: leaves }
        crossCache.set(urn, out)
        return out
    }

    /** A card already on the board keeps the slot it was first drawn in;
     *  anything else ranks by weight, behind all of them. */
    const UNDRAWN = Number.MAX_SAFE_INTEGER
    const drawnRankOf = (urn: string): number => view.drawnRank.get(urn) ?? UNDRAWN
    const rankCards = (urns: string[]): string[] =>
        [...urns].sort((a, b) =>
            drawnRankOf(a) - drawnRankOf(b)
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
        const allGroups = rankedGroups(dir, urn)
        const remainingGroups = allGroups
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
                // T23 R3 — this key's WHOLE ranking, admitted or not: the
                // hub-triage gate's own stable "how big is this control"
                // fact (see `FocusPill.groupsTotal`'s own doc comment).
                groupsTotal: allGroups.length,
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
        count: 1, flowsIn: 0, flowsOut: 0, drawnIn: 0, drawnOut: 0,
        flowsInExact: true, flowsOutExact: true, showType: false, edgeTypeNorm: '',
        frameId: null, depth: 0,
        ancestry: EMPTY_STRINGS, ancestryIds: EMPTY_STRINGS,
        frameEmpty: false, nameLines: 1,
        gutterLanes: 0,
        connected: true, frameShowingAll: false, frameConnectedCount: 0,
        frameLoaded: 0, frameTotal: -1, frameHasMore: false,
        frameSearchedCount: 0, frameSearchedExact: true,
        frameSharedEdgeType: '',
        frameOffset: 0, frameWindowSize: FRAME_WINDOW, frameRows: NO_FRAME_ROWS,
        canOpenChildren: false, childrenOpen: false,
        expandKey: null, expanded: false, wired: false, deadEnd: false,
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

    /**
     * THE GRAIN TEST (T22, R1) — does this entity hold finer things: known
     * children in the model, or a declared/roster total promising more?
     * The same signal R7's `isFrame` reads (`heldTotal`), asked of a hop's
     * own endpoint rather than of a card's contents.
     *
     * A raw hop landing directly ON such an entity — rather than on one of
     * its own finer children — is coarser than the finest grain the model
     * could show for it: a table declaring columns it never named in THIS
     * hop is table-grain regardless of whether the table happens to be
     * drawn open or compact. Structural, never type-based, on purpose: a
     * source that never reports anything finer than "table" anywhere in
     * the walk has nothing coarser to contrast against, and nothing here
     * lights until it does.
     */
    const holdsThings = (urn: string): boolean =>
        (nodeOf(urn)?.children.length ?? 0) > 0 || (heldTotal(urn) ?? 0) > 0

    const contentsOf = (urn: string): { onLineage: number; total: number | null } | null => {
        const children = nodeOf(urn)?.children ?? []
        if (children.length === 0) return null
        const total = heldTotal(urn)
        // R1c — COUNT HONESTY: "k on this lineage · of N" must never
        // render with N < k. `heldTotal` trusts a DECLARED childCount at
        // face value, and a declared count that is stale or simply wrong
        // (the payload said 0 while the walk has since found 8 children
        // on this lineage) produced exactly that — "8 on this lineage ·
        // of 0" shipped this way. A total smaller than what the walk has
        // already found is not a total; the honest statement is
        // "unknown", never a number smaller than what is already drawn.
        return { onLineage: children.length, total: total != null && total >= children.length ? total : null }
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
        const kids = flowOrder(
            rankCards((nodeOf(urn)?.children ?? []).filter(c => visible.has(c))),
            internalHopsOf(urn),
        )
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
        // F2 — FIND FILTERS, IT DOES NOT MERELY DIM. `frameQuery` used to
        // only tag rows already inside the fixed scroll WINDOW below, so
        // a match sitting past row 20 of a 96-row table never appeared —
        // the window never moved to it, and the reader saw ten dimmed
        // strangers and nothing else. Filtering (and reordering matches
        // first) BEFORE the window is cut is what makes the window land
        // on an actual hit, in EITHER Connected or All mode.
        const frameQuery = (view.frameQueries.get(urn) ?? '').trim().toLowerCase()
        // A roster answers THIS Find only when it was fetched FOR this
        // exact question — a stale roster from the query before would
        // otherwise flash yesterday's hits as this one's answer.
        const rosterAnswers = frameQuery !== '' && (roster?.query ?? '') === frameQuery
        const rosterExtras = showAll && frameQuery === ''
            ? (roster?.children ?? [])
                .map(n => n.id)
                .filter(id => !visible.has(id) && !cardIdByUrn.has(id))
            : []
        // The server's own matches beyond what the walk already carries —
        // an entity Find can surface that a lineage answer never would,
        // in EITHER display mode (previously only fetched, and only
        // shown, in "everything inside").
        const searchHits = rosterAnswers
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
        const connectedRowsAll = kids.filter(child => !cardIdByUrn.has(child))
        // Connected participants search LOCALLY — the model is already
        // in hand, so filtering it costs nothing and needs no fetch.
        const connectedRows = frameQuery === ''
            ? connectedRowsAll
            : connectedRowsAll.filter(child => labelFor(child).toLowerCase().includes(frameQuery))
        const rows = frameQuery === '' ? [...connectedRows, ...rosterExtras] : [...connectedRows, ...searchHits]
        /**
         * ONE NODE FOR THE FOCUS (R7).
         *
         * The focus holds its contents the way every other container on
         * this board does: as ROWS INSIDE IT. It used to be a compact card
         * with a separate "Inside X" panel floating underneath — two boxes
         * for one entity, while its partners were each a single frame, and
         * the wires landed on the panel's rows rather than on the card, so
         * the thing the reader asked about read as an orphan above its own
         * contents.
         *
         * The test is what it HOLDS, not what happens to be drawn: a focus
         * whose contents are all off this lineage still opens, because
         * that is where "0 on this lineage · of 9" and "nothing inside is
         * on this lineage" get said. Dropping the node there would leave
         * the reader no way to ask what is in there.
         */
        // F2 — a Find matching NOTHING must still say so, not vanish: a
        // frame's existence is whether it HOLDS anything, never whether
        // the CURRENT search happens to match some of it. Reading this
        // off `rows.length` (the FILTERED list) made a query with zero
        // hits collapse the frame back to a bare entity — Find box,
        // roster region and all — with no way left to see or clear it.
        const holdsAnything = connectedRowsAll.length > 0 || rosterExtras.length > 0 || searchHits.length > 0
        const isFrame = isFocus
            ? (nodeOf(urn)?.children.length ?? 0) > 0 || rosterExtras.length > 0 || searchHits.length > 0 || (heldTotal(urn) ?? 0) > 0
            : holdsAnything
        // ...and it is SHOWING them: a focus the reader has shut is its
        // header and nothing else, exactly like a shut partner frame. A
        // focus that holds things and has no rows to show stays open —
        // that is where "nothing inside is on this lineage" gets said.
        const contentsOpen = isFocus ? isFrame && expanded.has(urn) : isFrame
        // A row INSIDE THE FOCUS is CONTENTS. Its lineage is the focus's
        // lineage — offered by the focal's ⊕ — so a row neither carries a
        // pill of its own nor gets to claim that the walk ended at it.
        const { pillUp, pillDown, deadEnd } = focusContents.has(urn)
            ? { pillUp: null, pillDown: null, deadEnd: false }
            : walkStateOf(urn, isFrame, band)
        const windowSize = showAll ? FRAME_WINDOW_ALL : FRAME_WINDOW
        // The scroll window can never travel past what has loaded: a
        // restored share link, or a roster that shrank under a new
        // search, must land on rows rather than on empty space.
        const offset = Math.min(
            Math.max(0, view.frameOffsets.get(urn) ?? 0),
            Math.max(0, rows.length - windowSize),
        )

        const card: FocusCard = {
            ...baseCard(),
            // The focus keeps its own id and kind whether or not it holds
            // anything: it is the thing you asked about, which is what
            // centres it on the midline and what the accent is for. What
            // R7 changed is how it PRESENTS what it holds, not what it is.
            //
            // T27 — `id` no longer branches on `isFrame`. It used to
            // (`fr:${urn}` vs `n:${urn}`), which meant a card's React
            // Flow id itself changed the moment `kind` flipped from
            // 'entity' to 'frame' (its first child arriving) — a SECOND,
            // independent remount mechanism alongside the node TYPE flip
            // (`FocusNode`'s own doc comment covers that one): React Flow
            // keys its nodes array by id, so a changed id is a removed
            // node plus an added one, not an update, whatever the type
            // unification does. Safe to drop: de-duplication in
            // `pushCard` above is keyed by `card.nodeId` (the urn) via
            // `cardIdByUrn`, never by `card.id` itself, so the prefix was
            // never load-bearing for the "one entity, one card" rule —
            // purely a labeling convention, and the one this task's own
            // bug lived in.
            id: isFocus ? 'f' : `n:${urn}`,
            kind: isFocus ? 'focal' : isFrame ? 'frame' : 'entity',
            nodeId: urn,
            band,
            // A row host is sized from its contents by `layoutBands`; this
            // is the height a card that holds nothing keeps.
            h: isFocus ? FOCAL_H : CARD_H,
            depth,
            label,
            description: (dataOf(urn).description as string | undefined) ?? null,
            freshness: (dataOf(urn).lastSyncedAt as string | undefined) ?? null,
            type: typeFor(urn),
            frameId: hostFrameId,
            nameLines: nameLinesFor(label, ancestry.length > 0 || parent != null),
            parentId: parent,
            parentLabel: parent ? labelFor(parent) : null,
            ancestry: ancestry.map(labelFor),
            ancestryIds: ancestry,
            count: Math.max(1, weightOf(urn)),
            // What this card is connected to: what is drawn, plus what
            // the data source says is still out there. The pill for that
            // side already IS the remainder (a reveal's own not-yet-shown
            // cohort, or an extend/page's unfetched frontier), so the two
            // numbers cannot disagree — and a countless frontier makes it
            // a floor rather than a total.
            drawnIn: crossingOf(urn).in,
            drawnOut: crossingOf(urn).out,
            flowsIn: crossingOf(urn).in + (pillUp?.count ?? 0),
            flowsOut: crossingOf(urn).out + (pillDown?.count ?? 0),
            flowsInExact: pillUp == null || pillUp.count != null,
            flowsOutExact: pillDown == null || pillDown.count != null,
            canOpenChildren: (nodeOf(urn)?.children.length ?? 0) > 0,
            childrenOpen: contentsOpen,
            expandKey: urn,
            expanded: contentsOpen,
            wired: drawnIn.has(urn) || drawnOut.has(urn),
            // A focus that holds things always states both numbers, even
            // when NONE of what it holds is on this lineage — "0 on this
            // lineage · of 9" is the sentence that makes an open node with
            // no connected rows readable instead of alarming.
            contents: contentsOf(urn)
                ?? (isFocus && isFrame ? { onLineage: 0, total: heldTotal(urn) } : null),
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
            // question nobody asked. Carried by the focus too, which is
            // the same kind of node at the centre of the board.
            frameEmpty: (isFrame || isFocus) && (nodeOf(urn)?.children.length ?? 0) === 0,
            frameConnectedCount: connectedRows.length,
            // `rows.length` always — pre-F2 this equalled
            // `connectedRows.length` whenever `!showAll` anyway
            // (`rosterExtras` was empty outside "all"), but a Connected-
            // mode Find now ALSO appends `searchHits`, which the window
            // (built straight off `rows.length`) already accounts for.
            frameLoaded: rows.length,
            frameTotal: showAll ? (roster?.total ?? -1) : (contentsOf(urn)?.total ?? -1),
            frameHasMore: showAll ? (roster?.hasMore ?? false) : false,
            // F2 — the size of the space Find actually searched: every
            // connected participant (exact, nothing here pages) plus,
            // once the server has answered, its own reported extent.
            // R1c: a total smaller than what the server already RETURNED
            // is never rendered — floor to the returned count instead.
            frameSearchedCount: connectedRowsAll.length + (rosterAnswers
                ? Math.max(roster?.total ?? 0, roster?.children.length ?? 0)
                : 0),
            frameSearchedExact: !rosterAnswers || (roster?.hasMore !== true && roster?.total != null),
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
            // T24 F6 — 'unsupported' used to fall through to `null`
            // (indistinguishable from "never asked"), so a provider
            // that cannot list contents left the frame silently empty:
            // no spinner, no error, no retry — wired, but dead.
            fetch: isFocus && walkStatus === 'loading' ? 'loading'
                : isFocus && walkStatus === 'error' ? 'error'
                    : showAll && childrenAllStatus.get(urn) === 'loading' ? 'loading'
                        : showAll && childrenAllStatus.get(urn) === 'error' ? 'error'
                            : showAll && childrenAllStatus.get(urn) === 'unsupported' ? 'unsupported'
                                : null,
            dimmed: !matches(label) || (hostQuery !== '' && !label.toLowerCase().includes(hostQuery)),
        }
        const id = pushCard(card)
        if (id !== card.id) return

        // Rows go INSIDE this card — the focus's included. There is no
        // second card for the focus's contents any more: one entity, one
        // node, whether it is the thing you asked about or one of its
        // partners.
        //
        // OPEN, not merely holding: a shut node draws no rows, and the
        // view renders no list region around them (see `childrenOpen`).
        // The two came apart for a SHUT FOCUS showing "everything inside"
        // — shutting it takes its children out of `visible`, which is
        // exactly what makes every one of them a roster extra — and the
        // rows came out as loose cards under a node whose chevron said
        // there was nothing to see. For every other card the two are the
        // same test.
        if (!contentsOpen) return

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
                    frameId: card.id,
                    count: rosterExtras.length,
                    canOpenChildren: false,
                })
            }
            // T24 F6, state (i) — flipping to "everything inside" and
            // finding NOTHING beyond what was already connected looks
            // identical to the toggle having silently failed (the row
            // list is unchanged either way). Confirm it worked instead
            // of leaving the reader to infer a null result from an
            // unchanged list — but only once the roster has genuinely
            // finished (not mid-fetch, and not merely this page: a
            // roster with more pages still might turn up something).
            // `frameQuery === ''` (T24 F6 review round 1): `rosterExtras`
            // is forced to [] the moment a search is active (F2, above),
            // which made this fire on the STILL-UNSEEN rest of the roster
            // every time a query happened to match every connected row —
            // a false "everything inside is already on this lineage"
            // sitting right under the search's own match count.
            if (showAll && frameQuery === '' && connectedRows.length > 0 && rosterExtras.length === 0
                && !roster?.hasMore && childrenAllStatus.get(urn) === 'done'
                && i === rows.length - 1) {
                pushCard({
                    ...baseCard(),
                    id: `div-all:${urn}`,
                    kind: 'divider',
                    nodeId: null,
                    band,
                    h: DIVIDER_ROW_H,
                    depth: depth + 1,
                    label: 'everything inside is already on this lineage',
                    type: UNRESOLVED_TYPE,
                    frameId: card.id,
                    count: 0,
                    canOpenChildren: false,
                })
            }
            if (visible.has(child)) {
                emit(child, card.id, depth + 1, band, frameQuery)
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
                frameId: card.id,
                parentId: urn,
                parentLabel: label,
                connected: false,
                count: 0,
                canOpenChildren: false,
                // F2 — a server hit is a full citizen: it answered THIS
                // Find (the server matches displayName/urn, which is not
                // always the same substring test as the label below), so
                // it is never re-dimmed against `frameQuery` locally —
                // only the board-wide filter still applies, same as any
                // other row.
                dimmed: !matches(rosterLabel),
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

    /** A hop that goes BACKWARDS in the picture's own hop numbering:
     *  `B → A` where A is STRICTLY nearer the focus than B on the same
     *  side. Stated per-direction because a node can legitimately sit on
     *  both sides of a diamond without any cycle existing.
     *
     *  STRICTLY, and that is the whole of R4. The rule used to be `≤`,
     *  which stamped a loop on every ordinary flow between two cards at
     *  the SAME hop — two consumers of the focus where one also feeds the
     *  other is one-way lineage, and the picture called it a cycle
     *  (reported: a ↺ on a peer flow that goes strictly one way). Equal
     *  hops mean "same distance from the focus", never "backwards".
     *
     *  A same-hop wire that IS on a loop is caught by the other half of
     *  the rule — `sameComponent` below, which asks the drawn board
     *  itself rather than its numbering. */
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
        // Both ends rolled into one card, or into a card and something it
        // CONTAINS: the wire would leave a card and come straight back
        // into it. That is the contents talking among themselves — their
        // rows' counts and the drill say it — and as geometry it is the
        // stub arc that reads as a broken arrow.
        if (sUrn === tUrn || subtreeOf(sUrn).has(tUrn) || subtreeOf(tUrn).has(sUrn)) continue
        const source = cardIdByUrn.get(sUrn)!
        const target = cardIdByUrn.get(tUrn)!
        const id = `e:${source}>${target}`
        const existing = byPair.get(id)
        const norm = (bundle.edgeTypeNorm || '').toUpperCase()
        // THE GRAIN TEST, asked of the bundle's OWN (pre-second-rollup)
        // endpoints — see `holdsThings`. Asked here, not after `landingUrn`,
        // so an off-window ROW rolled up to its frame (T19: the same
        // grain, just scrolled past) is judged by what IT holds, never by
        // what the frame it lands on holds.
        const bundleCoarse = holdsThings(bundle.sourceUrn) || holdsThings(bundle.targetUrn)
        if (existing) {
            existing.count += bundle.weight
            if (existing.edgeTypeNorm !== norm) existing.edgeTypeNorm = ''
            existing.cycleBack = existing.cycleBack || runsBackwards(bundle)
            existing.grainCoarse = existing.grainCoarse || bundleCoarse
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
            // Both decided below: one from the loops, one from the
            // geometry — and there is no geometry yet.
            cycleAnchor: false,
            labelVisible: false,
            labelT: 0.5,
            grainCoarse: bundleCoarse,
            // Filled in just below, once every card's `frameId` is fixed.
            sameAncestorFrame: null,
            // Filled in by the in-frame routing pass below (the lane's own
            // `x` needs geometry, so it lands after `layoutBands`).
            inFrameLane: null,
            // Filled in by the badge-placement pass, below `layoutBands`.
            seamSlotted: false,
        })
    }
    const edges: FocusEdge[] = [...byPair.values()]

    /**
     * IN-FRAME ROUTING (T22, R2) — the nearest drawn ancestor frame BOTH
     * of a wire's cards sit under, so the view can route it INSIDE that
     * frame's own bounds instead of the ordinary bezier, which has no
     * notion of the box it is drawn over and can bow past its border —
     * the reported out-and-back exterior arc with arrowheads piling up at
     * the frame's edge.
     *
     * Nearest-first up EACH card's own `frameId` chain, so two cards two
     * levels apart still find the SHARED level rather than only a match at
     * the very top.
     */
    const frameChain = (cardId: string): string[] => {
        const chain: string[] = []
        let host = byId.get(cardId)?.frameId ?? null
        let guard = 0
        while (host && guard++ < 32) { chain.push(host); host = byId.get(host)?.frameId ?? null }
        return chain
    }
    for (const edge of edges) {
        const targetChain = new Set(frameChain(edge.target))
        for (const host of frameChain(edge.source)) {
            if (targetChain.has(host)) { edge.sameAncestorFrame = host; break }
        }
    }

    /**
     * IN-FRAME LANES — the routing half of "internal flow is vertical".
     *
     * A same-frame wire used to be a STRAIGHT LINE between two ports
     * (T22 R2, which fixed a bezier bowing outside the frame). A straight
     * line between two rows of a vertical list crosses every card between
     * them, and with the rows ordered by busy-ness rather than by flow it
     * crossed most of the frame to do it — reported live on a warehouse
     * frame whose one opened table fed two tables at the opposite end of
     * the stack.
     *
     * `flowOrder` above already put producers over consumers; here each
     * surviving wire claims a vertical lane in its frame's own left
     * gutter, so parallel runs never sit on top of each other and no wire
     * is ever drawn over a card again. The lane's own `x` needs the frame
     * to have a position, so it is resolved after `layoutBands`.
     */
    const rowsOfFrame = new Map<string, string[]>()
    for (const c of cards) {
        if (!c.frameId) continue
        const list = rowsOfFrame.get(c.frameId)
        if (list) list.push(c.id)
        else rowsOfFrame.set(c.frameId, [c.id])
    }
    /** Which ROW of `frameId` this card is, or sits inside — the card-space
     *  twin of `rowUnder`, since a lane is measured in row positions. */
    const rowCardUnder = (frameId: string, cardId: string): string | null => {
        let cursor: string | null = cardId
        let guard = 0
        while (cursor && guard++ < 32) {
            const host: string | null = byId.get(cursor)?.frameId ?? null
            if (host === frameId) return cursor
            cursor = host
        }
        return null
    }
    const internalByFrame = new Map<string, FocusEdge[]>()
    for (const edge of edges) {
        if (!edge.sameAncestorFrame) continue
        const list = internalByFrame.get(edge.sameAncestorFrame)
        if (list) list.push(edge)
        else internalByFrame.set(edge.sameAncestorFrame, [edge])
    }
    for (const [frameId, group] of internalByFrame) {
        const frame = byId.get(frameId)
        const order = rowsOfFrame.get(frameId)
        if (!frame || !order) continue
        const refs: InternalEdgeRef[] = []
        for (const edge of group) {
            const source = rowCardUnder(frameId, edge.source)
            const target = rowCardUnder(frameId, edge.target)
            if (!source || !target || source === target) continue
            refs.push({ id: edge.id, source, target })
        }
        if (refs.length === 0) continue
        const lanes = assignLanes(order, refs)
        let used = 0
        for (const edge of group) {
            const index = lanes.get(edge.id)
            if (index === undefined) continue
            edge.inFrameLane = { index, x: 0 }
            used = Math.max(used, index + 1)
        }
        frame.gutterLanes = used
    }

    // THE OTHER HALF OF R4: a wire whose two ends can reach each other
    // over the DRAWN board is on a directed loop, whatever the hop
    // numbering makes of it. Asked of the picture rather than of the
    // model, because the badge is a claim about what the reader can see:
    // a loop that runs through cards this page has not drawn is not a
    // loop the reader can follow, and marking it would be pointing at
    // something that is not there.
    //
    // Every wire of a loop is badged, not only the one that "closes" it
    // — which of them closes it is an artefact of the order the walk
    // happened to arrive in, and a single glyph beside an unmarked
    // partner wire reads as a duplicate rather than as a cycle.
    const component = sameComponent(edges)
    for (const edge of edges) {
        if (edge.cycleBack) continue
        const c = component.get(edge.source)
        if (c !== undefined && c === component.get(edge.target)) edge.cycleBack = true
    }

    // ...and ONE badge per loop that density may not take away. Badging
    // every wire of a cycle is right — but a cyclic estate is then a
    // board where every wire carries a glyph, which is the confetti the
    // density cap exists to stop. So each loop nominates a single wire
    // whose badge always draws: the lowest edge id among its own, which
    // is a choice of the SET rather than of the arrival order, so it
    // does not move when the reader reveals a card. A marked wire whose
    // two ends are in different components is its own loop of one — the
    // hop numbering found it, and one wire is all it has.
    const anchors = new Map<string, FocusEdge>()
    for (const edge of edges) {
        if (!edge.cycleBack) continue
        const c = component.get(edge.source)
        const key = c !== undefined && c === component.get(edge.target) ? `c:${c}` : edge.id
        const held = anchors.get(key)
        if (!held || edge.id < held.id) anchors.set(key, edge)
    }
    for (const edge of anchors.values()) edge.cycleAnchor = true

    // PORTS FOLLOW THE WIRES THAT WERE ACTUALLY DRAWN, not the hops the
    // model happens to name. A card only renders the handles a wire
    // anchors to when it is `wired`, and that was read off the walk's own
    // hops by urn: true for the row a hop names, false for the FRAME that
    // hop rolls up to when the row is scrolled past — no hop in the model
    // ever names the frame. React Flow then refuses a wire whose handle
    // does not exist, so the board drew two boxes, the frame's header
    // said "6 on this lineage", and no line ran between them.
    for (const edge of edges) {
        const s = byId.get(edge.source)
        const t = byId.get(edge.target)
        if (s) s.wired = true
        if (t) t.wired = true
    }

    // ── 5. GEOMETRY ──────────────────────────────────────────────────

    layoutBands(cards)

    // The lanes now have somewhere to be: their frame has a position, so
    // each one's absolute centre is the frame's own left padding plus its
    // slot. Innermost (index 0) hugs the rows.
    for (const edge of edges) {
        const lane = edge.inFrameLane
        if (!lane) continue
        const frame = edge.sameAncestorFrame ? byId.get(edge.sameAncestorFrame) : undefined
        if (!frame) { edge.inFrameLane = null; continue }
        edge.inFrameLane = {
            index: lane.index,
            x: frame.x + FRAME_PAD + gutterWidth(frame.gutterLanes) - LANE_GAP - (lane.index + 0.5) * LANE_W,
        }
    }

    // A ×N badge belongs to a wire, so it may only render where the wire
    // can hold one: long enough for a pill, and with nothing already
    // sitting there. Column-to-column lineage draws dozens of short
    // near-parallel hops through one screen, and a badge per hop came out
    // as a drift of pills with no visible owner.
    //
    // Measured between the ports the view actually anchors to (source's
    // right edge, target's left) and, first, at the straight-line
    // midpoint, which is where a shallow bezier puts its label to within a
    // few pixels. A cycle badge is not decided here — it is decided by
    // `cycleBack` and `cycleAnchor` above, and gated in the view by the
    // same `labelFitsRun` this uses.
    //
    // COLLISION-AWARE PLACEMENT (T22, R3): the midpoint is not the only
    // spot a badge may sit. Two adjacent rows of one frame feeding the
    // same port draw two near-parallel wires whose midpoints land within a
    // badge's own width of each other — reported live as a ×N stacked
    // under a crossing with no arrow legible under it. Rather than simply
    // dropping the second badge (the OLD behaviour: silent, first-come-
    // first-served), a few more points along the SAME wire are tried
    // before giving up — still between this wire's own two ports, never
    // borrowed from another edge's geometry.
    const LABEL_CANDIDATES = [0.5, 0.35, 0.65, 0.2, 0.8]
    const placed: Array<{ x: number; y: number }> = []
    for (const edge of edges) {
        // A ×N badge needs count > 1 to have anything to say; a grain
        // SEAM chip (T22, R1) needs a slot too, whatever its count is —
        // it is drawn whenever the wire is coarse, not when it is
        // bundled. Both compete for the same collision-avoided real
        // estate, so both are placed in the SAME pass.
        if (edge.count <= 1 && !edge.grainCoarse) continue
        const s = byId.get(edge.source)
        const t = byId.get(edge.target)
        if (!s || !t) continue
        const sx = s.x + s.w
        const sy = s.y + s.h / 2
        const tx = t.x
        const ty = t.y + t.h / 2
        if (!labelFitsRun(sx, sy, tx, ty)) continue
        let slot: { x: number; y: number; t: number } | null = null
        for (const frac of LABEL_CANDIDATES) {
            const x = sx + (tx - sx) * frac
            const y = sy + (ty - sy) * frac
            if (placed.some(p => Math.abs(p.x - x) < LABEL_W && Math.abs(p.y - y) < LABEL_H)) continue
            slot = { x, y, t: frac }
            break
        }
        if (!slot) continue
        placed.push({ x: slot.x, y: slot.y })
        // `labelVisible` stays what it always meant — a ×N worth
        // showing — even though a coarse wire now competes for this
        // pass's real estate too; the seam chip's OWN visibility is the
        // view's call (T22, R1 rule 2: cone-only), not this flag's.
        if (edge.count > 1) edge.labelVisible = true
        // A coarse wire that found NO clear candidate must not fall back
        // to drawing its badge at a stale/default spot anyway — that is
        // the exact overlap this pass exists to prevent, just for a seam
        // badge instead of a ×N one. `seamSlotted` stays false for it;
        // the view withholds the badge, and only the badge (fix round 1).
        if (edge.grainCoarse) edge.seamSlotted = true
        edge.labelT = slot.t
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

// ── isolation cone ───────────────────────────────────────────────────

/** The graded distance a SEAM entry (T22, R1b) reports — always "further"
 *  than an adjacent wire (`hops <= 1`), because a hop pulled in from an
 *  ancestor's own bundle is exactly that: further, and less certain, than
 *  anything the anchor is a direct endpoint of. */
const SEAM_HOP_DEPTH = 2

/** What one element's visible lineage covers — the answer a hover or a
 *  click asks for, computed over the DRAWN board and nothing else. */
export interface LensIsolationCone {
    /** Every card the cone lights: the anchor, whatever it holds, every
     *  drawn endpoint reachable from it, and the boxes those sit in. */
    cardIds: ReadonlySet<string>
    /** Every drawn wire on the cone. */
    edgeIds: ReadonlySet<string>
    /** Drawn hops from the anchor, 0 for the anchor and anything inside
     *  it. What the view reads to make the near lineage heavier than the
     *  far — a cone with no hierarchy is just a second kind of dimming. */
    hops: ReadonlyMap<string, number>
}

/**
 * The lineage cone of one element: everything it FLOWS INTO, everything
 * that FLOWS INTO IT, and the wires between — over the edges the board is
 * actually drawing.
 *
 * TWO DIRECTED WALKS, never one undirected one. A lens board is one
 * entity's lineage and is connected by construction, so an undirected
 * walk lights every card and isolates nothing. Directed, the rule the
 * reader can state holds: a SIBLING that feeds the same target as the
 * anchor is not on the anchor's cone — it is a different producer of a
 * shared consumer, which is exactly the fact worth being able to see.
 *
 * A card that HOLDS rows speaks for them: hovering a frame — or the
 * focus, which is one of these since R7 — takes the union of its rows'
 * cones plus its own bundles, because that is what "this container's
 * lineage" means when the container is the thing being pointed at.
 *
 * Containment ancestors of a lit card are lit too. They are not ON the
 * cone (no wire of theirs is), but a lit row inside a dimmed box reads as
 * a rendering fault rather than as an answer, and a box holding something
 * on the cone is part of what the reader has to see to follow it.
 *
 * `null` when the anchor touches no drawn wire at all — a roster extra,
 * or a board with nothing wired. The caller's contract is that null means
 * "isolate nothing", never "dim everything".
 */
export function isolationCone(
    graph: Pick<FocusGraph, 'cards' | 'edges'>,
    anchorId: string,
): LensIsolationCone | null {
    const cardById = new Map(graph.cards.map(c => [c.id, c]))
    if (!cardById.has(anchorId)) return null

    // The anchor SPEAKS FOR what it holds, to whatever depth it nests.
    const seeds = new Set<string>([anchorId])
    for (const card of graph.cards) {
        let host = card.frameId
        let guard = 0
        while (host && guard++ < 32) {
            if (host === anchorId) { seeds.add(card.id); break }
            host = cardById.get(host)?.frameId ?? null
        }
    }

    type Step = { to: string; edgeId: string }
    const downstream = new Map<string, Step[]>()
    const upstream = new Map<string, Step[]>()
    const link = (m: Map<string, Step[]>, from: string, step: Step) => {
        const list = m.get(from)
        if (list) list.push(step)
        else m.set(from, [step])
    }
    for (const e of graph.edges) {
        link(downstream, e.source, { to: e.target, edgeId: e.id })
        link(upstream, e.target, { to: e.source, edgeId: e.id })
    }

    const edgeIds = new Set<string>()
    /**
     * One direction, breadth-first, from every seed at once — with its
     * OWN depths.
     *
     * Per direction, deliberately: the two walks share a board but not a
     * route. A card the anchor flows INTO is not a step on the way to
     * something that flows into the anchor, so letting the second walk
     * read the first one's numbers measured a path that runs downstream
     * and then turns around — which is the mixed route two directed
     * walks exist to exclude. Merged below, nearest wins, so a card on
     * both sides keeps the shorter of two real distances.
     *
     * Breadth-first from all seeds at once means the first arrival at a
     * card IS its shortest distance; a second one can only be longer.
     */
    const walk = (adjacency: Map<string, Step[]>): Map<string, number> => {
        const depths = new Map<string, number>()
        for (const seed of seeds) depths.set(seed, 0)
        const queue = [...seeds]
        for (let i = 0; i < queue.length; i++) {
            const at = queue[i]
            const depth = depths.get(at)!
            for (const { to, edgeId } of adjacency.get(at) ?? []) {
                // The wire is on the cone whether or not its far end is
                // new — two branches of a diamond rejoining is two lit
                // wires into one lit card, not one.
                edgeIds.add(edgeId)
                if (depths.has(to)) continue
                depths.set(to, depth + 1)
                queue.push(to)
            }
        }
        return depths
    }
    const hops = new Map<string, number>()
    for (const depths of [walk(downstream), walk(upstream)]) {
        for (const [id, depth] of depths) {
            const known = hops.get(id)
            if (known === undefined || depth < known) hops.set(id, depth)
        }
    }

    // THE SEAM CUTS BOTH WAYS (T22, R1b — the under-claim). A ROW's own
    // walk above can come back with nothing simply because the coarse hop
    // it participates in was reported against its CONTAINING FRAME rather
    // than against the row itself — the model cannot say which of a
    // frame's rows a table-grain hop "really" belongs to, so the honest
    // answer is to show it, seamed, rather than let the row read as
    // unconnected.
    //
    // T26 R3 — TERMINATES at the FIRST seam, never climbs further. The
    // anchor's own immediate containing frame is the ONE seam host: its
    // direct coarse bundles light (one coarse hop — "connected at table
    // grain"), and that is where the detailed walk stops. Two things this
    // does NOT do, both on purpose: it never walks onward through `far`'s
    // OWN edges (a table-grain partner's own lineage is not this cone's
    // business), and — the fix itself, a prior version's actual bug — it
    // never climbs PAST this one host to a grandparent container and
    // admits ITS bundles too. Reported live: spotlighting a single column
    // whose table sat several containment levels deep, each level with its
    // own unrelated coarse traffic, lit most of the board — every ancestor
    // between the column and the platform root contributing its own
    // "entire coarse traffic", compounding level by level. The RULE: one
    // seam, one honest coarse hop, no transitive re-expansion — beyond it
    // the reader gets the seam chip ("trace columns"), not a claim the
    // cone did not actually walk. A frame anchor needs none of this: its
    // own bundles are already in `seeds`/`graph.edges` via the ordinary
    // walk above.
    const seamHost = cardById.get(anchorId)?.frameId ?? null
    if (seamHost) {
        for (const e of graph.edges) {
            if (!e.grainCoarse || (e.source !== seamHost && e.target !== seamHost)) continue
            edgeIds.add(e.id)
            const far = e.source === seamHost ? e.target : e.source
            // The ancestor frame itself reads NEARER than whatever its own
            // bundle reaches — it is, after all, where the anchor lives —
            // so the view's "which side continues" (source vs target hop
            // distance) still resolves correctly for a seam edge exactly
            // as it does for an ordinary graded one.
            if (!hops.has(seamHost)) hops.set(seamHost, SEAM_HOP_DEPTH)
            if (!hops.has(far)) hops.set(far, SEAM_HOP_DEPTH + 1)
        }
    }

    if (edgeIds.size === 0) return null

    const cardIds = new Set(hops.keys())
    // ...and the boxes the lit cards sit in.
    for (const id of [...cardIds]) {
        let host = cardById.get(id)?.frameId ?? null
        let guard = 0
        while (host && guard++ < 32) {
            cardIds.add(host)
            host = cardById.get(host)?.frameId ?? null
        }
    }
    return { cardIds, edgeIds, hops }
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
    /** WHERE IT LIVES, in full — every containment level above it, not
     *  just the one this picture happened to draw. `parentUrn` is null
     *  for a card whose container was demoted to a breadcrumb, which
     *  left a spreadsheet with no way to say where the thing was. */
    path: string
    /** Which SIDE of the focus this is on, and how far — the two facts a
     *  reader sorts and filters a lineage export by, and neither was in
     *  it. 'focus' for the subject itself. */
    direction: 'upstream' | 'downstream' | 'focus'
    hops: number
    /** What it is connected to, and how much of that is on this board:
     *  the same numbers the card itself states, so an export and the
     *  picture it came from cannot disagree. */
    drawnIn: number
    drawnOut: number
    knownIn: number
    knownOut: number
}

export interface WalkExportEdge {
    sourceUrn: string
    targetUrn: string
    /** '' when the bundle carries more than one relationship type. */
    type: string
    weight: number
    /** This flow stays INSIDE one container rather than crossing the
     *  board — the distinction the gutter lanes draw, kept in the data
     *  so a reader can separate "within SILVER" from "SILVER to GOLD". */
    insideContainer: boolean
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
            path: c.ancestry.length > 0 ? c.ancestry.join(' › ') : (c.parentLabel ?? ''),
            direction: c.band === 0 ? 'focus' as const : c.band < 0 ? 'upstream' as const : 'downstream' as const,
            hops: Math.abs(c.band),
            drawnIn: c.drawnIn,
            drawnOut: c.drawnOut,
            knownIn: c.flowsIn,
            knownOut: c.flowsOut,
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
        insideContainer: e.sameAncestorFrame !== null,
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
        'urn,name,type,path,direction,hops,parentUrn,depth,drawnIn,drawnOut,knownIn,knownOut',
        ...payload.nodes.map(n => [
            n.urn, n.name, n.type, n.path, n.direction, n.hops,
            n.parentUrn, n.depth, n.drawnIn, n.drawnOut, n.knownIn, n.knownOut,
        ].map(csvField).join(',')),
    ]
    const edgeRows = [
        'sourceUrn,targetUrn,type,weight,insideContainer',
        ...payload.edges.map(e => [
            e.sourceUrn, e.targetUrn, e.type, e.weight, e.insideContainer ? 'yes' : 'no',
        ].map(csvField).join(',')),
    ]
    return [...nodeRows, '', ...edgeRows].join('\n')
}
