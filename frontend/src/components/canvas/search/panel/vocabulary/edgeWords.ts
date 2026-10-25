/**
 * edgeWords — how edges are named: an edge type by this app's word or its
 * own name made readable, a set of edges ("lineage", "any link", "Produces
 * or Consumes edges"), and the graph-shape conditions by the edges they
 * count — "No upstream lineage", "Nothing links into it", "No incoming
 * edges". The Form's rows, the palette, the sentence and the chips all read
 * them here, so one set of edges is never called two things.
 */
import { edgeTypeCopy, relationshipLabel } from '@/lib/relationshipLabel'
import type { DegreePredicate, EdgeClass } from '@/types/search'


/** An edge type as people read it: "Produces", "Tagged with", "Combined flow". */
export function edgeTypeName(id: string): string {
    return edgeTypeCopy(id)?.label ?? relationshipLabel(id)
}

/** Names joined as a list reads: "A", "A or B", "A, B or C". */
function joinedOr(names: string[]): string {
    return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
}


/** The edges a graph-shape or edge-count condition counts: a class of
 *  them, or edge types it names. */
export type EdgeSet = EdgeClass | 'types'

interface EdgeSetted {
    edgeClass?: EdgeClass | null
    edgeTypes?: string[] | null
}

export function edgeSetOf(p: EdgeSetted): EdgeSet {
    return p.edgeTypes ? 'types' : (p.edgeClass ?? 'lineage')
}

export const EDGE_SET_OPTIONS: ReadonlyArray<{ value: EdgeSet; label: string; description: string }> = [
    { value: 'lineage', label: 'Lineage', description: 'The edges data flows along' },
    { value: 'links', label: 'Any link',
      description: 'Every edge but the hierarchy’s — lineage, tags, glossary terms and the rest' },
    { value: 'any', label: 'Any edge', description: 'Every edge, the hierarchy’s included' },
    { value: 'containment', label: 'Containment', description: 'What contains what' },
    { value: 'types', label: 'These edge types…', description: 'Only the edge types you pick' },
]

/** The predicate counting ``set`` instead: a class, or edge types — none
 *  picked yet. */
export function withEdgeSet<P extends EdgeSetted>(p: P, set: EdgeSet): P {
    const { edgeClass: _c, edgeTypes: _t, ...rest } = p
    return (set === 'types' ? { ...rest, edgeTypes: [] } : { ...rest, edgeClass: set }) as P
}

/** An edge set in a few words: "lineage", "any link", "any edge",
 *  "containment", "Produces or Consumes edges". */
export function edgeSetPhrase(p: EdgeSetted): string {
    if (p.edgeTypes) return p.edgeTypes.length ? `${joinedOr(p.edgeTypes.map(edgeTypeName))} edges` : 'edge types to pick'
    return { lineage: 'lineage', links: 'any link', any: 'any edge', containment: 'containment' }[p.edgeClass ?? 'lineage']
}


// ---------------------------------------------------------------------------
// Graph shapes
// ---------------------------------------------------------------------------

export type ShapeKind = 'isRoot' | 'isLeaf' | 'isOrphan' | 'hasIncoming' | 'hasOutgoing'

type Words = Record<EdgeClass, string> & { types: (names: string) => string }

const SHAPE_LABELS: Record<ShapeKind, Words> = {
    isRoot: { lineage: 'No upstream lineage', links: 'Nothing links into it',
        any: 'No incoming edges', containment: 'Not inside anything',
        types: (n) => `No incoming ${n} edges` },
    isLeaf: { lineage: 'No downstream lineage', links: 'Links to nothing',
        any: 'No outgoing edges', containment: 'Contains nothing',
        types: (n) => `No outgoing ${n} edges` },
    isOrphan: { lineage: 'No lineage edges', links: 'No links at all', any: 'No edges at all',
        containment: 'Outside the hierarchy', types: (n) => `No ${n} edges` },
    hasIncoming: { lineage: 'Has upstream lineage', links: 'Something links into it',
        any: 'Has incoming edges', containment: 'Inside something',
        types: (n) => `Has incoming ${n} edges` },
    hasOutgoing: { lineage: 'Has downstream lineage', links: 'Links to something',
        any: 'Has outgoing edges', containment: 'Contains something',
        types: (n) => `Has outgoing ${n} edges` },
}

/** A graph-shape condition named for the edges it counts. */
export function shapeLabel(kind: ShapeKind, p: EdgeSetted): string {
    const words = SHAPE_LABELS[kind]
    const set = edgeSetOf(p)
    return set === 'types' ? words.types(joinedOr((p.edgeTypes ?? []).map(edgeTypeName)) || 'these')
        : words[set]
}

type Phrases = Record<EdgeClass, [one: string, many: string]> & {
    types: (names: string) => [one: string, many: string]
}

const SHAPE_PHRASES: Record<ShapeKind, Phrases> = {
    isRoot: {
        lineage: ['has no upstream lineage', 'have no upstream lineage'],
        links: ['nothing links into', 'nothing links into'],
        any: ['has no incoming edges', 'have no incoming edges'],
        containment: ['is not inside anything', 'are not inside anything'],
        types: (n) => [`has no incoming ${n} edges`, `have no incoming ${n} edges`],
    },
    isLeaf: {
        lineage: ['has no downstream lineage', 'have no downstream lineage'],
        links: ['links to nothing', 'link to nothing'],
        any: ['has no outgoing edges', 'have no outgoing edges'],
        containment: ['contains nothing', 'contain nothing'],
        types: (n) => [`has no outgoing ${n} edges`, `have no outgoing ${n} edges`],
    },
    isOrphan: {
        lineage: ['has no lineage edges', 'have no lineage edges'],
        links: ['has no links at all', 'have no links at all'],
        any: ['has no edges at all', 'have no edges at all'],
        containment: ['is outside the hierarchy', 'are outside the hierarchy'],
        types: (n) => [`has no ${n} edges`, `have no ${n} edges`],
    },
    hasIncoming: {
        lineage: ['has upstream lineage', 'have upstream lineage'],
        links: ['something links into', 'something links into'],
        any: ['has incoming edges', 'have incoming edges'],
        containment: ['is inside something', 'are inside something'],
        types: (n) => [`has incoming ${n} edges`, `have incoming ${n} edges`],
    },
    hasOutgoing: {
        lineage: ['has downstream lineage', 'have downstream lineage'],
        links: ['links to something', 'link to something'],
        any: ['has outgoing edges', 'have outgoing edges'],
        containment: ['contains something', 'contain something'],
        types: (n) => [`has outgoing ${n} edges`, `have outgoing ${n} edges`],
    },
}

/** The same in a sentence, describing one entity or several: "has no
 *  upstream lineage", "nothing links into", "link to nothing". */
export function shapePhrase(kind: ShapeKind, p: EdgeSetted, many: boolean): string {
    const phrases = SHAPE_PHRASES[kind]
    const set = edgeSetOf(p)
    const [one, several] = set === 'types'
        ? phrases.types(joinedOr((p.edgeTypes ?? []).map(edgeTypeName)) || 'these')
        : phrases[set]
    return many ? several : one
}


// ---------------------------------------------------------------------------
// Edge counts
// ---------------------------------------------------------------------------

export const DEGREE_DIRECTION_OPTIONS: ReadonlyArray<{
    value: NonNullable<DegreePredicate['direction']>; label: string; description: string
}> = [
    { value: 'in', label: 'Incoming', description: 'Edges that point to it' },
    { value: 'out', label: 'Outgoing', description: 'Edges that leave it' },
    { value: 'both', label: 'Either way', description: 'Edges in and out, together' },
]

export const DEGREE_OP_WORDS: Record<NonNullable<DegreePredicate['op']>, string> = {
    gte: 'at least', gt: 'more than', eq: 'exactly', lte: 'at most', lt: 'fewer than',
    neq: 'other than',
}

/** An edge count in words: "more than 5 links, either way", "at least 2
 *  incoming Produces edges". */
export function degreePhrase(p: DegreePredicate): string {
    const n = p.value
    const set = edgeSetOf(p)
    const unit = n === 1 ? 'edge' : 'edges'
    const what = set === 'types' ? `${joinedOr((p.edgeTypes ?? []).map(edgeTypeName))} ${unit}`
        : set === 'links' ? (n === 1 ? 'link' : 'links')
        : set === 'any' ? unit
        : `${set} ${unit}`
    const dir = p.direction ?? 'both'
    return dir === 'both'
        ? `${DEGREE_OP_WORDS[p.op ?? 'eq']} ${n} ${what}, either way`
        : `${DEGREE_OP_WORDS[p.op ?? 'eq']} ${n} ${dir === 'in' ? 'incoming' : 'outgoing'} ${what}`
}
