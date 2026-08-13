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

    const spine = new Set<string>()
    for (const group of admittedGroups) {
        let cursor: string | null = group.root
        const guard = new Set<string>()
        while (cursor && population.has(cursor) && !guard.has(cursor)) {
            guard.add(cursor)
            const kids = childrenInPopulation(cursor)
            // The first level that BRANCHES is the answer — stop there and
            // let it speak for what is inside it.
            if (kids.length !== 1) break
            spine.add(cursor)
            cursor = kids[0]
        }
    }

    const expanded = new Set<string>([...view.expandedContainment, ...spine])
    for (const urn of view.collapsedContainment) expanded.delete(urn)

    // ── 3. VISIBILITY ────────────────────────────────────────────────

    // Pre-order, parents before children: `visibleLensNodes` stops at any
    // closed node, which IS the "every ancestor must be open" rule, and
    // the population is ancestor-closed so nothing is stranded.
    const visibleOrder = visibleLensNodes(sg, expanded).filter(u => population.has(u))
    const visible = new Set(visibleOrder)
    const projected = projectLensEdges(sg, population, visible)

    /**
     * What each visible card VISUALLY STANDS FOR: itself, plus every
     * population member whose nearest visible ancestor it is.
     *
     * This is the same rule `projectLensEdges` uses to decide where a
     * hop lands, applied to the ⊕ — and it has to be, or a frontier gets
     * reported once per containment level above it. Five nested frames
     * each grew their own copy of one column's "+2", four of which could
     * not be acted on separately and which piled up on top of each other
     * in the gutter. A card offers exactly what it stands for.
     */
    const standsFor = new Map<string, Set<string>>()
    for (const urn of visible) standsFor.set(urn, new Set([urn]))
    for (const urn of population) {
        if (visible.has(urn)) continue
        let cursor: string | null = model.get(urn)?.parent ?? null
        const guard = new Set<string>()
        while (cursor && !guard.has(cursor)) {
            if (visible.has(cursor)) { standsFor.get(cursor)!.add(urn); break }
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
        // that of anything collapsed inside it.
        const entries = [...owned]
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
        frameTruncated: false, frameEmpty: false,
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

    const contentsOf = (urn: string): { onLineage: number; total: number | null } | null => {
        const children = nodeOf(urn)?.children ?? []
        if (children.length === 0) return null
        const declared = dataOf(urn).childCount
        const roster = childrenAll.get(urn)
        const total = typeof declared === 'number' && declared >= 0
            ? declared
            : roster?.total ?? null
        return { onLineage: children.length, total }
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
    const emit = (urn: string, hostFrameId: string | null, depth: number, band: number) => {
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
        const isFrame = rows.length > 0
        const { pillUp, pillDown, deadEnd } = walkStateOf(urn, isFrame, band)
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
            dimmed: !matches(label),
        }
        const id = pushCard(card)
        if (id !== card.id || !isFrame) return

        // ONE fixed window of rows, so a 500-column table and a 5-column
        // one occupy the same room and a page click moves the window
        // rather than growing the frame.
        for (const child of rows.slice(page * pageSize, page * pageSize + pageSize)) {
            if (visible.has(child)) {
                emit(child, card.id, depth + 1, band)
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
                frameId: card.id,
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
    // at the top of its band.
    const roots = rankCards(visibleOrder.filter(u => (nodeOf(u)?.parent ?? null) === null))
    for (const root of [...roots].sort((a, b) => signedHop(a) - signedHop(b))) {
        const band = signedHop(root)
        // The whole band a direction filter hides — never emitted, so its
        // cards, pills AND edges (an edge needs both endpoints' card ids)
        // are all absent at once. Band 0 (the focus's own subtree) is
        // never a "side" and is never skipped.
        if (directionFilter === 'in' && band > 0) continue
        if (directionFilter === 'out' && band < 0) continue
        emit(root, null, 0, band)
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
        card.frameSharedEdgeType = host.frameSharedEdgeType
        // Rows get a row's height — but a FRAME is sized from its own
        // contents by layoutBands, and the FOCUS card carries the rich
        // focal chrome (name, provenance, in/out, reach) that does not
        // fit in 64px. Squashing it there spilled its own text out
        // through the bottom of the container holding it.
        if (card.kind === 'frame' || card.kind === 'focal') continue
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
    for (const bundle of projected) {
        const source = cardIdByUrn.get(bundle.sourceUrn)
        const target = cardIdByUrn.get(bundle.targetUrn)
        if (!source || !target) continue
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
        })
    }

    // ── 5. GEOMETRY ──────────────────────────────────────────────────

    layoutBands(cards)

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

    return {
        cards,
        edges,
        hiddenByChips,
        hiddenByChipsIn,
        hiddenByChipsOut,
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
        .map(c => ({ urn: c.nodeId!, name: c.label, type: c.type, parentUrn: c.parentId, depth: c.depth }))
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
 *  the literal string "null". */
function csvField(v: string | number | null): string {
    const s = v === null ? '' : String(v)
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
