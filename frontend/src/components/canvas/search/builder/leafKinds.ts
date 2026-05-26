/**
 * Catalog of leaf-predicate kinds the visual builder offers, with the
 * display metadata each entry needs in the "Add condition" picker and
 * a factory that creates an empty predicate of that kind.
 *
 * Sugar predicates (isOrphan / isLeaf / isRoot / hasIncoming /
 * hasOutgoing) appear as separate one-click chips here even though the
 * DegreeEditor handles all six wire kinds — pre-filling the right
 * fields beats teaching users what `direction=in, op=eq, value=0` means.
 *
 * Adding a leaf kind: append to LEAF_KINDS below + ensure
 * PredicateRow dispatches to an editor for it.
 */
import type { EdgeClass, Predicate } from '@/types/search'


export type LeafKind =
    | 'property'
    | 'hasProperty'
    | 'tag'
    | 'entityType'
    | 'layer'
    | 'text'
    | 'degree'
    | 'isOrphan'
    | 'isLeaf'
    | 'isRoot'
    | 'hasIncoming'
    | 'hasOutgoing'
    | 'descendantOf'
    | 'withinHops'
    | 'path'


export interface LeafKindMeta {
    kind: LeafKind
    /** Headline label shown on the picker chip. */
    label: string
    /** One-line description shown beneath the label. */
    description: string
    /** Lucide icon name (caller renders via DynamicIcon). */
    icon: string
    /** Pickers group leaves by category; renders as a section header. */
    category: 'property' | 'identity' | 'graph' | 'scope' | 'text'
    /** Build an empty leaf predicate of this kind, ready to edit. */
    makeEmpty: () => Predicate
}


const DEFAULT_EDGE_CLASS: EdgeClass = 'lineage'


export const LEAF_KINDS: readonly LeafKindMeta[] = [
    // -- property facet --------------------------------------------------
    {
        kind: 'property',
        label: 'Property value',
        description: 'Where a property equals, contains, or compares against a value (e.g. layer = silver).',
        icon: 'SlidersHorizontal',
        category: 'property',
        makeEmpty: () => ({
            kind: 'property',
            key: '',
            op: 'eq',
            value: '',
        }),
    },
    {
        kind: 'hasProperty',
        label: 'Property is set',
        description: 'Where a property key is present (or missing).',
        icon: 'KeyRound',
        category: 'property',
        makeEmpty: () => ({
            kind: 'hasProperty',
            key: '',
            negate: false,
        }),
    },
    {
        kind: 'tag',
        label: 'Tag',
        description: 'Has (or doesn\'t have) one or more tags.',
        icon: 'Tag',
        category: 'property',
        makeEmpty: () => ({
            kind: 'tag',
            op: 'has',
            values: [],
        }),
    },

    // -- identity --------------------------------------------------------
    {
        kind: 'entityType',
        label: 'Type of node',
        description: 'Restrict to specific entity types (dataset, schemaField, …).',
        icon: 'Boxes',
        category: 'identity',
        makeEmpty: () => ({
            kind: 'entityType',
            op: 'in',
            values: [],
        }),
    },
    {
        kind: 'layer',
        label: 'Layer',
        description: 'Pipeline layer (Source / Staging / Refinery / Report).',
        icon: 'Layers',
        category: 'identity',
        makeEmpty: () => ({
            kind: 'layer',
            layerAssignment: '',
        }),
    },

    // -- text ------------------------------------------------------------
    {
        kind: 'text',
        label: 'Text in name or description',
        description: 'Free-form match on name, qualified name, description, or tags.',
        icon: 'Search',
        category: 'text',
        makeEmpty: () => ({
            kind: 'text',
            value: '',
            target: 'name',
            match: 'substring',
            caseSensitive: false,
            boost: 1.0,
        }),
    },

    // -- graph shape -----------------------------------------------------
    {
        kind: 'isOrphan',
        label: 'Disconnected nodes',
        description: 'No edges of the chosen kind — both incoming and outgoing.',
        icon: 'Unplug',
        category: 'graph',
        makeEmpty: () => ({
            kind: 'isOrphan',
            edgeClass: DEFAULT_EDGE_CLASS,
        }),
    },
    {
        kind: 'isLeaf',
        label: 'Dead-end nodes',
        description: 'Nothing flows out of this node (no outgoing edges).',
        icon: 'CircleArrowRight',
        category: 'graph',
        makeEmpty: () => ({
            kind: 'isLeaf',
            edgeClass: DEFAULT_EDGE_CLASS,
        }),
    },
    {
        kind: 'isRoot',
        label: 'Source nodes',
        description: 'Nothing flows into this node (no incoming edges).',
        icon: 'CircleArrowLeft',
        category: 'graph',
        makeEmpty: () => ({
            kind: 'isRoot',
            edgeClass: DEFAULT_EDGE_CLASS,
        }),
    },
    {
        kind: 'hasIncoming',
        label: 'Has incoming edges',
        description: 'At least one edge points to this node.',
        icon: 'ArrowDownToLine',
        category: 'graph',
        makeEmpty: () => ({
            kind: 'hasIncoming',
            edgeClass: DEFAULT_EDGE_CLASS,
        }),
    },
    {
        kind: 'hasOutgoing',
        label: 'Has outgoing edges',
        description: 'At least one edge leaves this node.',
        icon: 'ArrowUpFromLine',
        category: 'graph',
        makeEmpty: () => ({
            kind: 'hasOutgoing',
            edgeClass: DEFAULT_EDGE_CLASS,
        }),
    },
    {
        kind: 'degree',
        label: 'Edge count (custom)',
        description: 'Filter by exact number of incoming/outgoing edges.',
        icon: 'GitBranchPlus',
        category: 'graph',
        makeEmpty: () => ({
            kind: 'degree',
            direction: 'both',
            op: 'eq',
            value: 0,
            edgeClass: DEFAULT_EDGE_CLASS,
        }),
    },

    // -- scope -----------------------------------------------------------
    {
        kind: 'descendantOf',
        label: 'Inside a subtree',
        description: 'Limit to nodes under one or more parent URNs.',
        icon: 'FolderTree',
        category: 'scope',
        makeEmpty: () => ({
            kind: 'descendantOf',
            urns: [],
        }),
    },
    {
        kind: 'path',
        label: 'Paths between two nodes',
        description: 'Find all paths from a source URN to a target URN (within N hops, along lineage edges). Replaces the rest of the query — path mode returns ordered node→edge→node sequences instead of flat hits.',
        icon: 'GitFork',
        category: 'scope',
        makeEmpty: () => ({
            kind: 'path',
            sourceUrns: [],
            targetUrns: [],
            direction: 'outgoing',
            edgeClass: DEFAULT_EDGE_CLASS,
            maxHops: 4,
            maxPaths: 32,
        }),
    },
    {
        kind: 'withinHops',
        label: 'Near a node',
        description: 'Within N relationship hops of an anchor URN.',
        icon: 'Waypoints',
        category: 'scope',
        makeEmpty: () => ({
            kind: 'withinHops',
            urns: [],
            hops: 1,
            direction: 'both',
        }),
    },
]


export function findLeafKind(kind: LeafKind): LeafKindMeta | undefined {
    return LEAF_KINDS.find((m) => m.kind === kind)
}


/** Group LEAF_KINDS by category for picker rendering. */
export function leafKindsByCategory(): Record<LeafKindMeta['category'], LeafKindMeta[]> {
    const out: Record<LeafKindMeta['category'], LeafKindMeta[]> = {
        property: [],
        identity: [],
        graph: [],
        scope: [],
        text: [],
    }
    for (const m of LEAF_KINDS) out[m.category].push(m)
    return out
}
