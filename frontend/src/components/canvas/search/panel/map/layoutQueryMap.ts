/**
 * layoutQueryMap — a query's shape as a small diagram: what it finds in the
 * middle, the relatives its relationships reach around it, and the routes
 * it lies on.
 *
 *              [Finance]
 *                  │ is inside
 *   [Datasets] ──feeds──▶ [Chart]
 *    #PII          1–3 hops
 *
 * Lineage reads left to right — what feeds a node sits to its left, what it
 * feeds to its right — and containers sit above what they hold, contents
 * below. Every node and edge carries the token it opens in the sentence,
 * so a click on the map edits the query where the sentence says it.
 *
 * Pure: built from the Sentence's own lines, laid out on a grid.
 */
import type { NodeRef, Predicate, RelatedPredicate } from '@/types/search'

import { formatUrnLabel } from '@/lib/urnLabels'

import { axisMeta, refName, type RelationAxis } from '../relations'
import type { Sentence, SentenceLine } from '../sentence/clauseModel'
import { leafSegments, reachSegments, relationVerb, type Segment } from '../vocabulary/sentenceGrammar'


export const MAP_NODE_W = 136
export const MAP_NODE_H = 52
export const MAP_GAP_X = 72
export const MAP_GAP_Y = 36

export type MapNodeKind =
    /** What the query finds. */
    | 'subject'
    /** A relative of some type, or any relative. */
    | 'relative'
    /** Entities picked by name. */
    | 'named'

export interface MapNode {
    id: string
    kind: MapNodeKind
    /** The node's types — none: anything. */
    types: string[]
    /** Several of them ("Charts"), or one ("a Chart"). */
    several: boolean
    /** The names of a named node. */
    names: string[]
    /** Its other conditions, in words. */
    chips: string[]
    /** How the chips combine: a subject's clauses may be any of them. */
    chipsJoin: 'and' | 'or'
    /** Which count it shows: the query's total, or a relationship's
     *  relatives (by the listed clause's index). */
    count: { of: 'total' } | { of: 'where'; clause: number } | null
    /** The token a click opens. */
    token: string
    x: number
    y: number
}

export interface MapEdge {
    id: string
    from: string
    to: string
    /** "feeds", "is inside", "lies on a route". */
    label: string
    /** "1–3 hops", when it reaches further than one. */
    reach: string | null
    /** Which end the arrow points at: the far node, the near one, both or
     *  none (a container holds, it doesn't flow). */
    arrow: 'end' | 'start' | 'both' | 'none'
    /** Drawn dashed: a route, one of several alternatives, or excluded. */
    dashed: boolean
    /** Lineage in the accent, containment quieter, an exclusion in rose. */
    tone: 'accent' | 'muted' | 'rose'
    token: string
    /** The SVG path, and where its label sits. */
    d: string
    labelAt: { x: number; y: number }
    vertical: boolean
}

export interface QueryMapLayout {
    nodes: MapNode[]
    edges: MapEdge[]
    width: number
    height: number
}


type Dir = 'left' | 'right' | 'up' | 'down'

const AXIS_DIR: Record<RelationAxis, Dir> = {
    downstream: 'right', neighbor: 'right', upstream: 'left',
    parent: 'up', ancestor: 'up', root: 'up', child: 'down', descendant: 'down',
}

const STEP: Record<Dir, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }


/** A condition in words, as a chip on its node. */
export function segmentsText(segments: Segment[]): string {
    return segments.map((s) => {
        switch (s.t) {
            case 'text': case 'em': return s.text
            case 'value': return s.quoted ? `“${s.text}”` : s.text
            case 'gap': return '…'
            case 'cond': return 'anything that…'
            default: return ''
        }
    }).join('').replace(/\s+/g, ' ').trim()
}

const GROUP_WORDS = { and: 'all of', or: 'any of', not: 'none of' } as const

const namesOf = (urns?: string[] | null, refs?: NodeRef[] | null) =>
    [...(urns ?? []).map((u) => formatUrnLabel(u)), ...(refs ?? []).map(refName)]

function chipFor(line: Extract<SentenceLine, { kind: 'clause' | 'group' }>): string {
    if (line.kind === 'group') {
        const n = line.predicate.children.length
        return `${GROUP_WORDS[line.op]} ${n} condition${n === 1 ? '' : 's'}`
    }
    return segmentsText(leafSegments(line.predicate, false))
}

/** "1–3 hops" — what the sentence reads as "within 1–3 hops". */
function reachOf(p: RelatedPredicate): string | null {
    const seg = reachSegments(p).find((s) => s.t === 'text' && s.slot === 'hops')
    return seg && seg.t === 'text' ? seg.text.replace(/^within /, '') : null
}


interface Placed { node: MapNode; c: number; r: number }

/**
 * The map for ``sentence``, or one node alone when the query has no
 * relationship or route — nothing to draw but what it finds.
 */
export function layoutQueryMap(sentence: Sentence): QueryMapLayout {
    const placed = new Map<string, Placed>()
    const cells = new Set<string>()
    const pending: Array<Omit<MapEdge, 'd' | 'labelAt' | 'vertical'> & { dir: Dir }> = []

    const put = (node: Omit<MapNode, 'x' | 'y'>, near: Placed | null, dir: Dir) => {
        let [c, r] = near ? [near.c + STEP[dir][0], near.r + STEP[dir][1]] : [0, 0]
        // A taken cell: slide on — down the column beside a node, along
        // the row above or below it.
        while (cells.has(`${c},${r}`)) {
            if (dir === 'left' || dir === 'right') r += 1
            else c += 1
        }
        cells.add(`${c},${r}`)
        const p = { node: { ...node, x: 0, y: 0 }, c, r }
        placed.set(node.id, p)
        return p
    }

    const first = sentence.lines[0]
    const subject = put({
        id: 'subject', kind: 'subject', types: first.kind === 'subject' ? first.types : [], several: true,
        names: [], chips: [], chipsJoin: sentence.combine, count: { of: 'total' }, token: 'subject:types',
    }, null, 'right')

    // Lines arrive depth first: what is open above a line — the
    // relationships and groups it sits inside — says whose it is.
    const open: Array<{ depth: number; line: SentenceLine }> = []
    for (const line of sentence.lines) {
        if (line.kind === 'subject' || line.kind === 'add' || line.kind === 'code') continue
        while (open.length && open[open.length - 1].depth >= line.depth) open.pop()
        let ownerAt = -1
        for (let i = open.length - 1; i >= 0; i--) if (open[i].line.kind === 'relation') { ownerAt = i; break }
        const owner = ownerAt >= 0 ? placed.get(open[ownerAt].line.key)! : subject
        const group = open.slice(ownerAt + 1).find((o) => o.line.kind === 'group')?.line
        const within = group?.kind === 'group' ? group.op : null
        // A subject's listed clauses joined by "or" are alternatives too.
        const alternative = within === 'or' || (owner === subject && line.depth === 1 && sentence.combine === 'or')

        if (line.kind === 'group') {
            if (!within) owner.node.chips.push(chipFor(line))
            open.push({ depth: line.depth, line })
            continue
        }
        if (line.kind === 'relation') {
            const p = line.predicate
            const rel = line.relative
            const dir = AXIS_DIR[p.axis] ?? 'right'
            const near = put({
                id: line.key,
                kind: rel.kind === 'names' ? 'named' : 'relative',
                types: rel.kind === 'types' ? rel.types : [],
                several: p.count ? p.count.value !== 1 : p.quantifier === 'all',
                names: rel.kind === 'names' ? namesOf([], rel.refs) : [],
                chips: [], chipsJoin: 'and',
                count: line.topIndex !== null && rel.kind !== 'names' ? { of: 'where', clause: line.topIndex } : null,
                token: `${line.key}:rel`,
            }, owner, dir)
            const lineage = axisMeta(p.axis).lineage
            const excluded = within === 'not' || p.quantifier === 'none'
            pending.push({
                id: line.key, from: owner.node.id, to: near.node.id, dir,
                label: relationVerb(p, false), reach: reachOf(p),
                arrow: !lineage ? 'none' : p.axis === 'neighbor' ? 'both' : p.axis === 'upstream' ? 'start' : 'end',
                dashed: excluded || alternative, tone: excluded ? 'rose' : lineage ? 'accent' : 'muted',
                token: `${line.key}:verb`,
            })
            open.push({ depth: line.depth, line })
            continue
        }
        // A route: from its source, through what lies on it, to its target.
        if (line.predicate.kind === 'path') {
            const p = line.predicate
            const end = (side: 'source' | 'target', urns?: string[] | null, refs?: NodeRef[] | null,
                where?: Predicate | null) => {
                const names = namesOf(urns, refs)
                return put({
                    id: `${line.key}:${side}`, kind: names.length ? 'named' : 'relative', types: [],
                    several: false, names, chips: where ? [segmentsText(leafSegments(where, false))] : [],
                    chipsJoin: 'and', count: null, token: `${line.key}:0`,
                }, owner, side === 'source' ? 'left' : 'right')
            }
            const source = end('source', p.sourceUrns, p.sourceRefs, p.sourceWhere)
            const target = end('target', p.targetUrns, p.targetRefs, p.targetWhere)
            const tone = within === 'not' ? 'rose' : 'accent'
            pending.push({ id: `${line.key}:from`, from: owner.node.id, to: source.node.id, dir: 'left',
                label: 'lies on a route', reach: `up to ${p.maxHops ?? 4} hops`, arrow: 'start',
                dashed: true, tone, token: `${line.key}:0` })
            pending.push({ id: `${line.key}:to`, from: owner.node.id, to: target.node.id, dir: 'right',
                label: '', reach: null, arrow: 'end', dashed: true, tone, token: `${line.key}:0` })
            continue
        }
        if (!within) owner.node.chips.push(chipFor(line))
    }

    // Onto pixels: the grid's top-left cell at the origin.
    const all = [...placed.values()]
    const minC = Math.min(...all.map((p) => p.c))
    const minR = Math.min(...all.map((p) => p.r))
    for (const p of all) {
        p.node.x = (p.c - minC) * (MAP_NODE_W + MAP_GAP_X)
        p.node.y = (p.r - minR) * (MAP_NODE_H + MAP_GAP_Y)
    }
    const cols = Math.max(...all.map((p) => p.c)) - minC + 1
    const rows = Math.max(...all.map((p) => p.r)) - minR + 1

    const edges: MapEdge[] = pending.map(({ dir, ...e }) => {
        const a = placed.get(e.from)!.node
        const b = placed.get(e.to)!.node
        const vertical = dir === 'up' || dir === 'down'
        let x1: number, y1: number, x2: number, y2: number, d: string
        if (vertical) {
            const down = b.y > a.y
            ;[x1, y1] = [a.x + MAP_NODE_W / 2, down ? a.y + MAP_NODE_H : a.y]
            ;[x2, y2] = [b.x + MAP_NODE_W / 2, down ? b.y : b.y + MAP_NODE_H]
            const dy = (y2 - y1) / 2
            d = `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`
        } else {
            const right = b.x > a.x
            ;[x1, y1] = [right ? a.x + MAP_NODE_W : a.x, a.y + MAP_NODE_H / 2]
            ;[x2, y2] = [right ? b.x : b.x + MAP_NODE_W, b.y + MAP_NODE_H / 2]
            const dx = (x2 - x1) / 2
            d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
        }
        return { ...e, d, labelAt: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }, vertical }
    })

    return {
        nodes: all.map((p) => p.node),
        edges,
        width: cols * MAP_NODE_W + (cols - 1) * MAP_GAP_X,
        height: rows * MAP_NODE_H + (rows - 1) * MAP_GAP_Y,
    }
}
