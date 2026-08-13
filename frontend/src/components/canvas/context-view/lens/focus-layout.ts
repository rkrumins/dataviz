/**
 * focus-layout — the Lineage Lens's layout engine for the WALK MODEL.
 *
 * Pure: `(walk subgraph + view state) → FocusGraph`. No React, no fetch,
 * no store. It emits the SAME `FocusGraph` contract `FocusGraphView`
 * already renders, so the walk path and the old neighbor-record path can
 * both be on the board while the rebuild lands (the new capabilities ride
 * on OPTIONAL card/edge fields the old builder never sets).
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
 *  5. GEOMETRY — signed hop distance is the column; `layoutBands` (shared
 *     with the old builder) stacks and sizes, deepest frame first.
 *
 * HONESTY RULES, carried over verbatim from the old builder because they
 * are contracts of the lens rather than of an implementation: the text
 * filter DIMS and never removes; the type chips remove but report what
 * they removed; a cap states its exact remainder; a dead end is a claim
 * about the data source and is only ever made once the walk says 'done'.
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
} from './focus-graph'

/** Upstream ('in') and downstream ('out') — the lens's own words, and the
 *  same two the old builder uses. The walk HOOK speaks 'up'/'down';
 *  `walkStatusKey` is the one place that translates. */
export type LensDir = 'in' | 'out'

/** New top-level cards one ⊕ click reveals.
 *
 *  Counted in GROUPS, not entities: a group is one root-most container,
 *  so twelve groups is twelve cards however many leaves nest inside them.
 *  Sized like the old band cap — a card is ~74px, so twelve fill a ~950px
 *  lens body. */
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
    // rank must not depend on which pages happen to be open, or paging
    // would re-order the cards already on the board (and, worse, keep
    // finding "new" top-ranked groups forever).
    const seed = new Set(population)

    const groupCache = new Map<string, RevealGroup[]>()
    /** Groups of not-yet-shown neighbours reachable from `near`, ranked.
     *  Weight is raw hops — the wire the reveal would draw. */
    const groupsFrom = (dir: LensDir, near: ReadonlySet<string>, cacheKey: string): RevealGroup[] => {
        const hit = groupCache.get(cacheKey)
        if (hit) return hit
        const byRoot = new Map<string, { weight: number; members: Set<string> }>()
        for (const hop of sg.lineageEdges) {
            const from = dir === 'in' ? hop.targetUrn : hop.sourceUrn
            const far = dir === 'in' ? hop.sourceUrn : hop.targetUrn
            if (!near.has(from) || near.has(far) || seed.has(far)) continue
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
        groupsFrom(dir, subtreeOf(urn), `sub:${dir}:${urn}`)

    const revealedKeys = [...view.revealed.keys()].sort()
    const admittedGroups: RevealGroup[] = []
    /** Fixpoint. A key only becomes live once its own card is in the
     *  picture (revealing under a card revealed by another key), so this
     *  iterates; because the ranking is frozen, it converges in at most
     *  one pass per key and the result is the same deterministic union
     *  whatever order the keys are in. */
    for (let pass = 0; pass < revealedKeys.length + 1; pass++) {
        let changed = false
        for (const key of revealedKeys) {
            const parsed = splitKey(key)
            const pages = view.revealed.get(key) ?? 0
            if (!parsed || pages <= 0 || !population.has(parsed.urn)) continue
            for (const group of rankedGroups(parsed.dir, parsed.urn).slice(0, pages * REVEAL_PAGE)) {
                let fresh = false
                for (const member of group.members) if (admit(member)) fresh = true
                if (fresh) changed = true
                if (!admittedGroups.some(g => g.root === group.root)) admittedGroups.push(group)
            }
        }
        if (!changed) break
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

    /** The one ⊕ this card offers in this direction, or null when the
     *  walk here is drained. Three states, in priority order:
     *
     *    reveal — neighbours ALREADY IN THE MODEL that this page hasn't
     *             shown yet. Free: no fetch, exact count.
     *    page   — the server handed back a cursor for a partial
     *             adjacency; carry it verbatim.
     *    extend — the server says more exists beyond the model. Exact
     *             remainder when it reported a total, a countless
     *             chevron when it did not (never a fabricated number). */
    const pillFor = (urn: string, dir: LensDir): FocusPill | null => {
        const owned = ownedBy(urn)
        // What this direction could still show from data already in hand.
        // A group another card's reveal happened to admit is not offered
        // again — the count is what clicking would actually add.
        const remainingGroups = groupsFrom(dir, owned, `own:${dir}:${urn}`)
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
        count: 1, edgeTypeNorm: '', sumCount: 0,
        rollup: false, unresolved: false, aggregated: false,
        frameId: null, depth: 0,
        ancestry: EMPTY_STRINGS, ancestryIds: EMPTY_STRINGS, alsoAtGrains: EMPTY_STRINGS,
        frameBreadcrumb: EMPTY_STRINGS, frameTruncated: false, frameEmpty: false,
        connected: true, frameShowingAll: false, frameConnectedCount: 0,
        frameLoaded: 0, frameTotal: -1, frameHasMore: false,
        // The walk model IS the roster for what connects: collapsing a
        // frame is a re-projection over data in hand, never a fetch.
        frameLocal: true,
        frameSharedEdgeType: '', alreadyShown: false,
        framePage: 0, framePageSize: FRAME_CHILD_CAP,
        partnerIds: EMPTY_STRINGS, partnerLabel: null,
        canOpenChildren: false, childrenOpen: false,
        expandKey: null, expanded: false,
        expandKind: null, frontier: false, frontierExpanded: false, deadEnd: false,
        degreeHint: null, fetch: null,
        dimmed: false, matchesInside: 0,
        overflowCount: 0, previewLabels: EMPTY_STRINGS,
        // The strangler discriminator: the view renders the walk branches
        // ONLY on cards carrying this, so the old path is untouched.
        walk: true,
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
        const pillUp = askUp ? pillFor(urn, 'in') : null
        const pillDown = askDown ? pillFor(urn, 'out') : null
        // The end of a walk is worth stating exactly where the picture
        // does NOT already state it: on the OUTWARD side of a card that
        // has no wire there. A frame never claims it — its rows carry the
        // lineage, and the frame saying "ends here" over an open estate
        // full of live connections is simply false. And "nothing further
        // exists" is a claim about the DATA SOURCE, so it waits for the
        // walk to actually report done.
        const outwardDir: LensDir = band < 0 ? 'in' : 'out'
        const asked = outwardDir === 'in' ? askUp : askDown
        const pill = outwardDir === 'in' ? pillUp : pillDown
        const drawn = outwardDir === 'in' ? drawnIn.has(urn) : drawnOut.has(urn)
        const deadEnd = walkStatus === 'done' && !isFrame && asked && pill === null && !drawn
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
        emit(root, null, 0, signedHop(root))
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
        card.h = rowHeight(host.frameSharedEdgeType, card.edgeTypeNorm, EMPTY_STRINGS)
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
            aggregated: false,
            containment: false,
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
        // The walk model nests instead of restating one connection at
        // four grains, so there is nothing to fold away.
        foldedAway: 0,
        foldedGrains: EMPTY_STRINGS,
    }
}
