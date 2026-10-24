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
    ListTree,
    Milestone,
    Network,
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

import { newRelation, RELATION_DEPTH_MAX } from '../relations'


const DEFAULT_EDGE_CLASS: EdgeClass = 'lineage'

/** The condition kinds with no visual editor: authored in Code. */
export type CodeKind = 'withinHops' | 'degree'

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
    build?: () => Predicate
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
        ],
    },
    {
        label: 'Relationships',
        entries: [
            {
                id: 'rel-parent',
                icon: ArrowUpToLine, tone: 'structure',
                label: 'Parent is…',
                description: 'A condition on the container one level up — "datasets whose parent is a domain"',
                action: 'emit',
                build: () => newRelation('parent', { kind: 'entityType', op: 'in', values: [] }),
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
                label: 'Any container above it…',
                description: 'A condition on any ancestor — "inside anything with region = EMEA"',
                action: 'emit',
                build: () => newRelation('ancestor', { kind: 'property', key: '', op: 'eq', value: '' }),
            },
            {
                id: 'rel-child',
                icon: FolderTree, tone: 'structure',
                label: 'Contains…',
                description: 'A condition on what it contains — "tables with a PII column"; every one, none, or how many',
                action: 'emit',
                build: () => newRelation('child', { kind: 'entityType', op: 'in', values: [] }),
            },
            {
                id: 'rel-upstream',
                icon: GitMerge, tone: 'lineage-present',
                label: 'Fed by…',
                description: 'A condition on its sources, one hop or several, through edges you choose',
                action: 'emit',
                build: () => newRelation('upstream', { kind: 'entityType', op: 'in', values: [] }),
            },
            {
                id: 'rel-downstream',
                icon: Workflow, tone: 'lineage-present',
                label: 'Feeds…',
                description: 'A condition on its targets — "feeds a dashboard within 3 hops"',
                action: 'emit',
                build: () => newRelation('downstream', { kind: 'entityType', op: 'in', values: [] }),
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
                id: 'degree',
                icon: GitBranchPlus, tone: 'group',
                label: 'Number of edges…',
                description:
                    'Entities with more, fewer or exactly N edges — Code only. '
                    + 'Opens the JSON editor with a stub; fill in '
                    + 'direction, op and value.',
                action: 'code',
                codeKind: 'degree',
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
                if (e.action === 'code') return canCode
                if (e.action === 'advanced') return canAdvanced
                return true
            }),
        }))
        .filter((cat) => cat.entries.length > 0)
}
