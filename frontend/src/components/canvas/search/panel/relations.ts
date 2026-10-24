/**
 * relations — the words and rules of relationship conditions, shared by
 * the row editor, the sentence, the palette and Code mode.
 *
 * A relationship (`kind: 'related'`) matches entities by the entities
 * related to them: up the containment tree (parent, any ancestor, the
 * top-level container), down it (child, any descendant), or along lineage —
 * what feeds it (upstream), what it feeds (downstream), either. Its
 * `where` is any condition, relationships included, so conditions chain.
 * The server's model (`backend/common/models/search.py`, RelatedPredicate)
 * is the authority on shapes; these mirror its caps so the editor never
 * offers what the server would refuse.
 */
import type { NodeRef, Predicate, RelatedPredicate } from '@/types/search'

import { formatUrnLabel } from '@/lib/urnLabels'


export type RelationAxis = RelatedPredicate['axis']
export type Quantifier = NonNullable<RelatedPredicate['quantifier']>

export interface AxisMeta {
    axis: RelationAxis
    /** Menu label. */
    label: string
    /** What the relative is called, singular and plural: "parent",
     *  "parents"; for lineage, "source" — never in/out, so the direction
     *  can't be misread. */
    noun: string
    plural: string
    /** Lineage axes walk edges, so take hops, edge types and an edge
     *  filter; containment axes walk the tree. */
    lineage: boolean
    /** Whether a hop range applies (one-step axes and `root` take none). */
    hops: boolean
    description: string
}

export const AXES: AxisMeta[] = [
    { axis: 'parent', label: 'Parent', noun: 'parent', plural: 'parents', lineage: false,
      hops: false, description: 'The container one level up' },
    { axis: 'ancestor', label: 'Any ancestor', noun: 'ancestor', plural: 'ancestors',
      lineage: false, hops: true, description: 'Any container above it' },
    { axis: 'root', label: 'Top-level container', noun: 'top-level container',
      plural: 'top-level containers', lineage: false, hops: false,
      description: 'The container at the top of its tree' },
    { axis: 'child', label: 'Child', noun: 'child', plural: 'children', lineage: false,
      hops: false, description: 'What it contains directly' },
    { axis: 'descendant', label: 'Any descendant', noun: 'descendant', plural: 'descendants',
      lineage: false, hops: true, description: 'Anything inside it, at any depth' },
    { axis: 'upstream', label: 'Source (upstream)', noun: 'source', plural: 'sources',
      lineage: true, hops: true, description: 'What feeds it, through lineage' },
    { axis: 'downstream', label: 'Target (downstream)', noun: 'target', plural: 'targets',
      lineage: true, hops: true, description: 'What it feeds, through lineage' },
    { axis: 'neighbor', label: 'Linked either way', noun: 'linked entity',
      plural: 'linked entities', lineage: true, hops: true,
      description: 'What feeds it or what it feeds' },
]

const BY_AXIS: Record<string, AxisMeta> = Object.fromEntries(AXES.map((a) => [a.axis, a]))

export function axisMeta(axis: RelationAxis): AxisMeta {
    return BY_AXIS[axis] ?? AXES[0]
}

/** How deep relationships nest (`DEEP_SEARCH_MAX_RELATION_DEPTH`). */
export const RELATION_DEPTH_MAX = 3
/** Lineage hops tested from every candidate (`DEEP_SEARCH_RELATION_MAX_HOPS`). */
export const RELATION_MAX_HOPS = 3
/** Lineage hops walked from entities a relationship names (as withinHops). */
export const RELATION_NAMED_MAX_HOPS = 10
/** How far up or down the tree an ancestor / descendant looks by default. */
export const TREE_DEPTH_MAX = 20

/** The hops a relationship follows, fewest and most, as the server reads
 *  them (`RelatedPredicate.hop_range`). */
export function hopRange(p: RelatedPredicate): [number, number] {
    const meta = axisMeta(p.axis)
    if (!meta.hops) return p.axis === 'root' ? [1, TREE_DEPTH_MAX] : [1, 1]
    const lo = p.minHops ?? 1
    if (meta.lineage) return [lo, p.maxHops ?? lo]
    return [lo, p.maxHops ?? TREE_DEPTH_MAX]
}

/** Whether its far end is named entities — an `is`, inside one, or an OR of
 *  those (the server's `anchor_groups`): walked from them, so lineage may go
 *  as far as within-hops does — at the top of the query. */
export function namesItsFarEnd(p: RelatedPredicate): boolean {
    return (p.quantifier ?? 'any') === 'any' && !p.count && namesEntities(p.where)
}

function namesEntities(p: Predicate | null | undefined): boolean {
    if (!p) return false
    if (p.kind === 'is') return true
    if (p.kind === 'related') {
        return p.axis === 'ancestor' && (p.quantifier ?? 'any') === 'any' && !p.count
            && p.where?.kind === 'is'
    }
    if (p.kind === 'group') {
        const op = p.op ?? 'and'
        return op !== 'not' && (op === 'or' || p.children.length === 1)
            && p.children.length > 0 && p.children.every(namesEntities)
    }
    return false
}

/** The most lineage hops this relationship may follow where it stands. */
export function maxHopsFor(p: RelatedPredicate, { topLevel, rule }: {
    topLevel: boolean
    rule: boolean
}): number {
    if (rule) return 1
    return topLevel && namesItsFarEnd(p) ? RELATION_NAMED_MAX_HOPS : RELATION_MAX_HOPS
}

/** A new relationship along ``axis``: no condition yet (any relative). */
export function newRelation(axis: RelationAxis, where?: Predicate): RelatedPredicate {
    return where ? { kind: 'related', axis, where } : { kind: 'related', axis }
}

/** How many relationships deep a predicate goes. */
export function relationDepth(p: Predicate | null | undefined): number {
    if (!p) return 0
    if (p.kind === 'group') return Math.max(0, ...p.children.map(relationDepth))
    if (p.kind === 'related') return 1 + relationDepth(p.where ?? null)
    if (p.kind === 'path') {
        return Math.max(relationDepth(p.sourceWhere ?? null), relationDepth(p.targetWhere ?? null))
    }
    return 0
}


// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** ``**`` in a name path: any number of levels. */
export const ANY_DEPTH = '**'

/** A reference as people read it: its name path joined with " / ", or
 *  the URN's label. */
export function refLabel(ref: NodeRef): string {
    if (ref.path && ref.path.length) {
        const text = ref.path.join(' / ')
        return ref.entityType ? `${text} (${ref.entityType})` : text
    }
    return ref.urn ? formatUrnLabel(ref.urn, 48) : '…'
}

/** A reference as a token or the map shows it: by name, without the
 *  "anywhere" (``**``) its path may start with. */
export function refName(ref: NodeRef): string {
    return refLabel(ref.path && ref.path.length > 1 && ref.path[0] === '**' ? { ...ref, path: ref.path.slice(1) } : ref)
}

/** A name path typed as text: segments split on "/", "\/" a slash in a
 *  name and "\\" a backslash, each trimmed; empty segments dropped. */
export function parseNamePath(text: string): string[] {
    const out: string[] = []
    let current = ''
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (ch === '\\' && (text[i + 1] === '/' || text[i + 1] === '\\')) {
            current += text[i + 1]
            i += 1
        } else if (ch === '/') {
            out.push(current.trim())
            current = ''
        } else {
            current += ch
        }
    }
    out.push(current.trim())
    return out.filter(Boolean)
}

/** A name as a path holds it: its slashes and backslashes escaped. */
function escapeName(name: string): string {
    return name.replace(/[\\/]/g, '\\$&')
}

/** A name path as text: the inverse of ``parseNamePath``. */
export function formatNamePath(path: string[]): string {
    return path.map(escapeName).join('/')
}

/** The paths of names that could name one entity, fewest names first: its
 *  name anywhere in the view (``** / name``), then with each container
 *  above it, and its whole path from the top, which reads first of two as
 *  long. Names a reference can't hold (blank, padded, longer than 256, or
 *  ``**`` itself) and paths past 12 names are left out. */
export function pathCandidates(name: string, ancestors: string[]): string[][] {
    const ok = (s: string) => s.length > 0 && s.length <= 256 && s.trim() === s && s !== ANY_DEPTH
    if (!ok(name)) return []
    const candidates: string[][] = []
    for (let k = 0; k <= ancestors.length; k++) {
        const above = ancestors.slice(ancestors.length - k)
        if (above.every(ok) && k + 2 <= 12) candidates.push([ANY_DEPTH, ...above, name])
    }
    if (ancestors.every(ok) && ancestors.length < 12) candidates.push([...ancestors, name])
    return candidates.sort((a, b) =>
        a.length - b.length || Number(a[0] === ANY_DEPTH) - Number(b[0] === ANY_DEPTH))
}

/** The text a reference is typed as in the name picker. */
export function refText(ref: NodeRef | null | undefined): string {
    if (!ref) return ''
    if (ref.urn) return ref.urn
    return (ref.path ?? []).map(escapeName).join(' / ')
}

/** The reference typed text names: a URN, or a name path. */
export function textToRef(text: string): NodeRef | null {
    const trimmed = text.trim()
    if (!trimmed) return null
    if (/^urn:/i.test(trimmed)) return { urn: trimmed }
    const path = parseNamePath(trimmed)
    return path.length ? { path } : null
}
