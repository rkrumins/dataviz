/**
 * filterKinds — the one catalog of conditions a person can add to a query:
 * what each is called, how it is described, its icon, and the empty
 * condition it starts as. The "+ Add filter" palette, the Sentence
 * builder's "+ and…" menu and the plain-words Ask bar all read it, so a
 * condition is never called two things in two places.
 */
import {
    AlignLeft,
    ArrowUpToLine,
    Asterisk,
    Boxes,
    Cable,
    CircleOff,
    Columns3,
    Crosshair,
    Equal,
    Flag,
    FolderTree,
    GitBranch,
    GitBranchPlus,
    GitMerge,
    Hash,
    KeyRound,
    Layers,
    Link2,
    Link2Off,
    ListTree,
    Milestone,
    Network,
    PackageSearch,
    Parentheses,
    Radar,
    Route,
    Share2,
    Tag,
    Type,
    Unplug,
    Workflow,
    type LucideIcon,
} from 'lucide-react'

import type { EdgeClass, Predicate } from '@/types/search'

import { newRelation, RELATION_DEPTH_MAX, RELATION_MAX_HOPS } from '../relations'


const DEFAULT_EDGE_CLASS: EdgeClass = 'lineage'

/** The condition kinds with no visual editor: authored in Code. */
export type CodeKind = 'withinHops'

/** Where a condition is being added: a display rule follows lineage one
 *  step, a search up to three. */
export interface BuildContext {
    rule?: boolean
}

const ANY_TYPE: Predicate = { kind: 'entityType', op: 'in', values: [] }

/** Lineage along ``axis`` to a type to pick: 1–3 steps, as the canvas and
 *  Ask read "feeds" — one in a display rule. */
function lineageTo(axis: 'upstream' | 'downstream', { rule = false }: BuildContext = {}): Predicate {
    return { kind: 'related', axis, ...(rule ? {} : { maxHops: RELATION_MAX_HOPS }), where: ANY_TYPE }
}

/**
 * Per-category icon accents, so the categories read apart at a glance —
 * text cyan, structure emerald, governance amber, a missing lineage
 * signal rose, a present one teal, groups violet.
 */
export type IconTone =
    | 'text'
    | 'structure'
    | 'governance'
    | 'lineage-missing'   // negative — "no X" rows
    | 'lineage-present'   // positive — "has X" rows
    | 'group'

export const ICON_TONES: Record<IconTone, { container: string; icon: string }> = {
    text: {
        container: 'bg-sky-500/[0.10] border-sky-500/25 dark:bg-sky-500/[0.14]',
        icon: 'text-sky-600 dark:text-sky-400',
    },
    structure: {
        container: 'bg-emerald-500/[0.10] border-emerald-500/25 dark:bg-emerald-500/[0.14]',
        icon: 'text-emerald-600 dark:text-emerald-400',
    },
    governance: {
        container: 'bg-amber-500/[0.10] border-amber-500/30 dark:bg-amber-500/[0.14]',
        icon: 'text-amber-700 dark:text-amber-300',
    },
    // Rose reads as "warning / gap", so "no upstream" (these are sources)
    // never reads like "has upstream" (these are sinks).
    'lineage-missing': {
        container: 'bg-rose-500/[0.10] border-rose-500/25 dark:bg-rose-500/[0.14]',
        icon: 'text-rose-600 dark:text-rose-400',
    },
    // Teal sits between the structure emerald and the text sky.
    'lineage-present': {
        container: 'bg-teal-500/[0.10] border-teal-500/25 dark:bg-teal-500/[0.14]',
        icon: 'text-teal-600 dark:text-teal-400',
    },
    group: {
        container: 'bg-violet-500/[0.10] border-violet-500/25 dark:bg-violet-500/[0.14]',
        icon: 'text-violet-600 dark:text-violet-400',
    },
}

/** What a kind's count chip counts in the view. */
export type CountKey = 'entityTypes' | 'tags' | 'propertyKeys' | 'layers'

export interface FilterKind {
    id: string
    icon: LucideIcon
    tone: IconTone
    label: string
    description: string
    /** The view's count for this kind ("4 in this view"), if any. */
    countKey?: CountKey
    /**
     *  - ``emit``: build a condition and add it to the query.
     *  - ``advanced``: open the Advanced drawer.
     *  - ``code``: hand off to Code mode with a stub of ``codeKind``.
     */
    action: 'emit' | 'advanced' | 'code'
    build?: (where?: BuildContext) => Predicate
    codeKind?: CodeKind
    /** The plain words people use for it — what the Ask bar reads as it. */
    examples?: readonly string[]
}

export interface FilterCategory {
    label: string
    entries: readonly FilterKind[]
}


export const FILTER_CATEGORIES: readonly FilterCategory[] = [
    {
        label: 'Text',
        entries: [
            {
                id: 'text-name',
                icon: Type, tone: 'text',
                label: 'Name contains…',
                description: 'Substring match against the display name',
                action: 'emit',
                build: () => ({
                    kind: 'text', value: '', target: 'name',
                    match: 'substring', caseSensitive: false, boost: 1.0,
                }),
            },
            {
                id: 'text-qname',
                icon: Hash, tone: 'text',
                label: 'Qualified name contains…',
                description: 'Match against the fully-qualified name',
                action: 'emit',
                build: () => ({
                    kind: 'text', value: '', target: 'qualifiedName',
                    match: 'substring', caseSensitive: false, boost: 1.0,
                }),
            },
            {
                id: 'text-desc',
                icon: AlignLeft, tone: 'text',
                label: 'Description contains…',
                description: 'Match against the entity description',
                action: 'emit',
                build: () => ({
                    kind: 'text', value: '', target: 'description',
                    match: 'substring', caseSensitive: false, boost: 1.0,
                }),
            },
        ],
    },
    {
        label: 'Structure',
        entries: [
            {
                id: 'entity-type',
                icon: Boxes, tone: 'structure',
                label: 'Entity type is…',
                description: 'Restrict to specific node types',
                countKey: 'entityTypes',
                action: 'emit',
                build: () => ({
                    kind: 'entityType', op: 'in', values: [],
                }),
            },
            {
                id: 'root-in-view',
                icon: Layers, tone: 'structure',
                label: 'Root in view is…',
                description:
                    'Restrict to entities under one of the view\'s '
                    + 'top-level containers (e.g. SILVER, GOLD, a '
                    + 'top-level Layer). The simple, common case — '
                    + 'pick from the same containers visible at the '
                    + 'top of the canvas tree.',
                countKey: 'layers',
                action: 'emit',
                // ``uiScope: 'roots'`` is the FE-only hint that routes
                // ConditionRow to the roots-only picker. Stripped at the
                // API boundary so the wire predicate is plain ``descendantOf``.
                build: () => ({
                    kind: 'descendantOf', urns: [],
                    uiScope: 'roots',
                } as Predicate),
            },
            {
                id: 'in-layer',
                icon: Columns3, tone: 'structure',
                label: 'In layer…',
                description:
                    'In one of this view\'s layers, the way the canvas places '
                    + 'it: by hand, by the layer\'s rules, or with its container.',
                countKey: 'layers',
                action: 'emit',
                build: () => ({ kind: 'layer', layerAssignment: '' }),
            },
            {
                id: 'inside-subtree',
                icon: GitBranch, tone: 'structure',
                label: 'Inside Subtree',
                description:
                    'Restrict results to descendants of any node on '
                    + 'the canvas — Layer, Object, Container, or '
                    + 'deeper. Power-user isolation for searching '
                    + 'a specific section of the graph that isn\'t '
                    + 'a top-level root.',
                action: 'emit',
                build: () => ({
                    kind: 'descendantOf', urns: [],
                    uiScope: 'any',
                } as Predicate),
            },
        ],
    },
    {
        label: 'Tags & properties',
        entries: [
            {
                id: 'tag',
                icon: Tag, tone: 'governance',
                label: 'Tag is…',
                description: 'Has one or more of the chosen tags',
                countKey: 'tags',
                action: 'emit',
                build: () => ({
                    kind: 'tag', op: 'hasAny', values: [],
                }),
            },
            {
                id: 'has-property',
                icon: KeyRound, tone: 'governance',
                label: 'Has property…',
                description: 'A given metadata key is set on the node',
                countKey: 'propertyKeys',
                action: 'emit',
                build: () => ({
                    kind: 'hasProperty', key: '', negate: false,
                }),
            },
            {
                id: 'property',
                icon: Equal, tone: 'governance',
                label: 'Property compares to…',
                description: 'Filter by property = / ≠ / > / < value',
                countKey: 'propertyKeys',
                action: 'emit',
                build: () => ({
                    kind: 'property', key: '', op: 'eq', value: '',
                }),
            },
        ],
    },
    {
        label: 'Graph shape',
        entries: [
            {
                id: 'no-upstream',
                icon: Milestone, tone: 'lineage-missing',
                label: 'No upstream lineage',
                description: 'Source nodes — nothing feeds them',
                action: 'emit',
                build: () => ({
                    kind: 'isRoot', edgeClass: DEFAULT_EDGE_CLASS,
                }),
                examples: ['no upstream', 'sources', 'source', 'origins', 'nothing feeds'],
            },
            {
                id: 'no-downstream',
                icon: Flag, tone: 'lineage-missing',
                label: 'No downstream lineage',
                description: 'Terminal nodes — nothing reads from them',
                action: 'emit',
                build: () => ({
                    kind: 'isLeaf', edgeClass: DEFAULT_EDGE_CLASS,
                }),
                examples: ['no downstream', 'dead ends', 'dead end', 'terminal', 'unused', 'nothing reads'],
            },
            {
                id: 'no-lineage',
                icon: Unplug, tone: 'lineage-missing',
                label: 'No lineage edges',
                description: 'Disconnected nodes — no upstream AND no downstream',
                action: 'emit',
                build: () => ({
                    kind: 'isOrphan', edgeClass: DEFAULT_EDGE_CLASS,
                }),
                examples: ['no lineage', 'orphans', 'orphan', 'orphaned', 'disconnected', 'isolated'],
            },
            {
                id: 'has-upstream',
                icon: GitMerge, tone: 'lineage-present',
                label: 'Has upstream lineage',
                description: 'Nodes fed by at least one source',
                action: 'emit',
                build: () => ({
                    kind: 'hasIncoming', edgeClass: DEFAULT_EDGE_CLASS,
                }),
                examples: ['has upstream', 'with upstream', 'with sources'],
            },
            {
                id: 'has-downstream',
                icon: Share2, tone: 'lineage-present',
                label: 'Has downstream lineage',
                description: 'Nodes that feed at least one consumer',
                action: 'emit',
                build: () => ({
                    kind: 'hasOutgoing', edgeClass: DEFAULT_EDGE_CLASS,
                }),
                examples: ['has downstream', 'with downstream', 'with consumers'],
            },
            {
                id: 'no-links',
                icon: Link2Off, tone: 'lineage-missing',
                label: 'No links at all',
                description: 'Nothing links to it or from it — no lineage, tag, glossary term or other link',
                action: 'emit',
                build: () => ({ kind: 'isOrphan', edgeClass: 'links' }),
            },
            {
                id: 'no-edges',
                icon: CircleOff, tone: 'lineage-missing',
                label: 'No edges at all',
                description: 'No edge of any kind, the hierarchy’s included — entirely on its own',
                action: 'emit',
                build: () => ({ kind: 'isOrphan', edgeClass: 'any' }),
            },
            {
                id: 'degree',
                icon: GitBranchPlus, tone: 'lineage-present',
                label: 'Number of edges…',
                description: 'More, fewer or exactly so many edges — which way, and through which edges',
                action: 'emit',
                build: () => ({ kind: 'degree', direction: 'both', op: 'gt', value: 5, edgeClass: 'links' }),
            },
        ],
    },
    {
        label: 'Relationships',
        entries: [
            {
                id: 'rel-parent',
                icon: ArrowUpToLine, tone: 'structure',
                label: 'Is directly inside…',
                description: 'A condition on its container, one level up — "datasets directly inside a domain"',
                action: 'emit',
                build: () => newRelation('parent', ANY_TYPE),
            },
            {
                id: 'rel-root',
                icon: Network, tone: 'structure',
                label: 'Top-level container is…',
                description: 'A condition on the container at the top of its tree',
                action: 'emit',
                build: () => newRelation('root', {
                    kind: 'text', value: '', target: 'name', match: 'exact',
                    caseSensitive: false, boost: 1.0,
                }),
            },
            {
                id: 'rel-ancestor',
                icon: ListTree, tone: 'structure',
                label: 'Is inside…',
                description: 'A condition on any container above it — "inside anything with region = EMEA"',
                action: 'emit',
                build: () => newRelation('ancestor', { kind: 'property', key: '', op: 'eq', value: '' }),
            },
            {
                id: 'rel-child',
                icon: FolderTree, tone: 'structure',
                label: 'Directly contains…',
                description: 'A condition on what it holds, one level down — "tables with a PII column"; every one, none, or how many',
                action: 'emit',
                build: () => newRelation('child', ANY_TYPE),
            },
            {
                id: 'rel-descendant',
                icon: PackageSearch, tone: 'structure',
                label: 'Contains, at any depth…',
                description: 'A condition on anything inside it — "domains holding a dataset with no owner"',
                action: 'emit',
                build: () => newRelation('descendant', ANY_TYPE),
            },
            {
                id: 'rel-downstream',
                icon: Workflow, tone: 'lineage-present',
                label: 'Feeds…',
                description: 'A condition on what it feeds, through lineage — "feeds a dashboard within 3 steps"',
                action: 'emit',
                build: (where) => lineageTo('downstream', where),
            },
            {
                id: 'rel-upstream',
                icon: GitMerge, tone: 'lineage-present',
                label: 'Is fed by…',
                description: 'A condition on what feeds it, through lineage — one step or several',
                action: 'emit',
                build: (where) => lineageTo('upstream', where),
            },
            {
                id: 'rel-linked',
                icon: Link2, tone: 'lineage-present',
                label: 'Is linked to…',
                description: 'A condition on anything it is linked to — a tag, a glossary term, a job — any edge type, either way',
                action: 'emit',
                build: () => ({ kind: 'related', axis: 'neighbor', edgeClass: 'links', where: ANY_TYPE }),
            },
            {
                id: 'rel-edge-type',
                icon: Cable, tone: 'lineage-present',
                label: 'Connected through an edge type…',
                description: 'Linked through edge types you pick by name — "produced by a job", "defined by a glossary term"',
                action: 'emit',
                build: () => ({ kind: 'related', axis: 'neighbor', edgeTypes: [], where: ANY_TYPE }),
            },
            {
                id: 'rel-inside-feeds',
                icon: Workflow, tone: 'structure',
                label: 'Something inside it feeds…',
                description: 'A container whose contents feed something — "schemas with a table that feeds a Finance dashboard"',
                action: 'emit',
                build: (where) => newRelation('descendant', lineageTo('downstream', where)),
            },
            {
                id: 'is-named',
                icon: Crosshair, tone: 'structure',
                label: 'Is a named entity…',
                description: 'By its path of names — "Sales / orders" — or a URN',
                action: 'emit',
                build: () => ({ kind: 'is', refs: [] }),
            },
            {
                id: 'inside-named',
                icon: FolderTree, tone: 'structure',
                label: 'Inside a container named…',
                description: 'Under "Country / United Kingdom" — names, not URNs, so it works in every environment',
                action: 'emit',
                build: () => ({ kind: 'descendantOf', urns: [], uiScope: 'name' } as Predicate),
            },
        ],
    },
    {
        label: 'Advanced',
        entries: [
            {
                id: 'path',
                icon: Route, tone: 'group',
                label: 'Paths from A to B',
                description:
                    'Every route from named entities — or any entity meeting a '
                    + 'condition — to others, through edges you choose. '
                    + 'The results become the routes.',
                action: 'emit',
                build: () => ({
                    kind: 'path', sourceUrns: [], targetUrns: [], maxHops: 4,
                    edgeClass: 'lineage', direction: 'outgoing',
                } as Predicate),
            },
            {
                id: 'within-hops',
                icon: Radar, tone: 'group',
                label: 'Within N hops of…',
                description:
                    'N-hop neighbourhood of an anchor URN — Code only. '
                    + 'Opens the JSON editor with a stub; fill in '
                    + 'urns and hops.',
                action: 'code',
                codeKind: 'withinHops',
            },
            {
                id: 'all',
                icon: Asterisk, tone: 'group',
                label: 'Every entity',
                description: 'Every entity in the view — to count or export them all',
                action: 'emit',
                build: () => ({ kind: 'all' }),
            },
            {
                id: 'and-group',
                icon: Parentheses, tone: 'group',
                label: 'AND group',
                description: 'Group of conditions where every child must match',
                action: 'emit',
                build: () => ({ kind: 'group', op: 'and', children: [] }),
            },
            {
                id: 'or-group',
                icon: Parentheses, tone: 'group',
                label: 'OR group',
                description: 'Group of conditions where at least one child must match',
                action: 'emit',
                build: () => ({ kind: 'group', op: 'or', children: [] }),
            },
            {
                id: 'not-group',
                icon: Parentheses, tone: 'group',
                label: 'NOT group',
                description: 'Invert the result of the wrapped condition',
                action: 'emit',
                build: () => ({ kind: 'group', op: 'not', children: [] }),
            },
        ],
    },
]


const BY_ID: ReadonlyMap<string, FilterKind> = new Map(
    FILTER_CATEGORIES.flatMap((c) => c.entries.map((e) => [e.id, e] as const)))

export function filterKindById(id: string): FilterKind | undefined {
    return BY_ID.get(id)
}


/** Entries that scope the whole search, which a relationship's condition
 *  can't hold. */
const SCOPE_ENTRIES = new Set(['root-in-view', 'inside-subtree', 'inside-named', 'path', 'within-hops'])

export interface KindContext {
    /** How many relationships the conditions being added sit inside. */
    relationDepth: number
    /** A display rule's: it tests one entity, so it has no routes. */
    rule: boolean
    /** Whether Code mode is there to hand off to. */
    canCode: boolean
    /** Whether the Advanced drawer is there to hand off to. */
    canAdvanced: boolean
}

/** The categories, holding only what can be added where the conditions
 *  stand: a relationship's condition is about the relative (the scope of
 *  the search is the query's alone), and relationships nest only so deep.
 *  Categories left empty are dropped. */
export function availableCategories({ relationDepth, rule, canCode, canAdvanced }: KindContext): FilterCategory[] {
    return FILTER_CATEGORIES
        .map((cat) => ({
            ...cat,
            entries: cat.entries.filter((e) => {
                if (relationDepth > 0 && SCOPE_ENTRIES.has(e.id)) return false
                if (rule && e.id === 'path') return false
                if (relationDepth >= RELATION_DEPTH_MAX && e.id.startsWith('rel-')) return false
                // Two relationships deep: one more level than a single one.
                if (relationDepth >= RELATION_DEPTH_MAX - 1 && e.id === 'rel-inside-feeds') return false
                if (e.action === 'code') return canCode
                if (e.action === 'advanced') return canAdvanced
                return true
            }),
        }))
        .filter((cat) => cat.entries.length > 0)
}
