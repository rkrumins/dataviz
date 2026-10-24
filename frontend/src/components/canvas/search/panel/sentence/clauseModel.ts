/**
 * clauseModel — a query as the Sentence builder lays it out: one line per
 * clause, indented as the query nests.
 *
 *   Find [Datasets]                                   ← the subject
 *     that [feed] [a Dashboard] [within 1–3 hops]     ← a relationship
 *       ↳ that [is inside] [Finance]                  ← what the relative must be
 *     and [are tagged] [#PII]                         ← a clause
 *     and match [any] of:                             ← a group
 *       [name contains] ["orders"]
 *
 * Every line knows where its condition lives in the draft (a `Path`), so
 * an edit made on the line lands exactly there. Pure: no React, no store.
 */
import type { GroupPredicate, NodeRef, Predicate, RelatedPredicate } from '@/types/search'

import { RELATION_DEPTH_MAX } from '../relations'
import { connector, isOrInside } from '../vocabulary/sentenceGrammar'


// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** One step down: a group's child, or a relationship's condition. */
export type Step = { child: number } | { where: true }
export type Path = readonly Step[]

export function pathKey(path: Path): string {
    return path.map((s) => ('child' in s ? String(s.child) : 'w')).join('.') || 'root'
}

/** The draft as a group of top-level clauses — a lone condition is one. */
function asRoot(draft: Predicate | null): GroupPredicate {
    if (draft?.kind === 'group' && (draft.op === 'and' || draft.op === 'or')) return draft
    return { kind: 'group', op: 'and', children: draft ? [draft] : [] }
}

/** The root again, as compact as the builders keep it: one clause stands
 *  alone, none is nothing. */
function collapseRoot(root: GroupPredicate): Predicate | null {
    if (root.children.length === 0) return null
    if (root.children.length === 1 && root.op === 'and') return root.children[0]
    return root
}

export function getAt(draft: Predicate | null, path: Path): Predicate | null {
    let node: Predicate | null = asRoot(draft)
    for (const step of path) {
        if (!node) return null
        if ('child' in step) node = node.kind === 'group' ? node.children[step.child] ?? null : null
        else node = node.kind === 'related' ? node.where ?? null : null
    }
    return node
}

/** ``node`` with what's at ``path`` below it replaced by ``next`` — or
 *  removed when ``next`` is null. A relationship's condition emptied is
 *  dropped (any relative will do); a nested group emptied goes with it; a
 *  relationship's all-of condition left with one part becomes that part. */
function setIn(node: Predicate, path: Path, next: Predicate | null): Predicate | null {
    if (path.length === 0) return next
    const [step, ...rest] = path
    if ('child' in step) {
        if (node.kind !== 'group') return node
        const child = node.children[step.child]
        if (!child) return node
        const replaced = setIn(child, rest, next)
        const children = replaced
            ? node.children.map((c, i) => (i === step.child ? replaced : c))
            : node.children.filter((_, i) => i !== step.child)
        return { ...node, children }
    }
    if (node.kind !== 'related') return node
    const where = node.where ? setIn(node.where, rest, next) : (rest.length === 0 ? next : null)
    const tidy = tidyWhere(where)
    if (tidy) return { ...node, where: tidy }
    const bare = { ...node }
    delete bare.where
    return bare
}

function tidyWhere(where: Predicate | null): Predicate | null {
    if (!where) return null
    if (where.kind === 'group' && where.children.length === 0) return null
    if (where.kind === 'group' && where.op === 'and' && where.children.length === 1) return where.children[0]
    return where
}

export function setAt(draft: Predicate | null, path: Path, next: Predicate | null): Predicate | null {
    const root = setIn(asRoot(draft), path, next)
    if (!root || root.kind !== 'group') return root
    // A nested group left empty is removed with its clause; the root itself
    // collapses to what the builders expect.
    const children = root.children.filter((c) => !(c.kind === 'group' && c.children.length === 0))
    return collapseRoot({ ...root, children })
}

/** ``draft`` with ``p`` added to the group or relationship condition at
 *  ``into`` (``[]``: the top-level clauses). */
export function insertAt(draft: Predicate | null, into: Path, p: Predicate): Predicate | null {
    if (into.length === 0) {
        const root = asRoot(draft)
        return collapseRoot({ ...root, children: [...root.children, p] })
    }
    const target = getAt(draft, into)
    const last = into[into.length - 1]
    if ('where' in last) {
        // A relationship's condition: the first part, or one more of all.
        const next: Predicate = !target ? p
            : target.kind === 'group' && target.op === 'and'
                ? { ...target, children: [...target.children, p] }
                : { kind: 'group', op: 'and', children: [target, p] }
        return setAt(draft, into, next)
    }
    if (target?.kind !== 'group') return draft
    return setAt(draft, into, { ...target, children: [...target.children, p] })
}

/** ``draft`` with ``p`` put first in the group or relationship condition at
 *  ``into`` — where a subject, or a relative's type, belongs. */
export function prependAt(draft: Predicate | null, into: Path, p: Predicate): Predicate | null {
    if (into.length === 0) {
        const root = asRoot(draft)
        return collapseRoot({ ...root, children: [p, ...root.children] })
    }
    const target = getAt(draft, into)
    const next: Predicate = !target ? p
        : target.kind === 'group' && target.op === 'and'
            ? { ...target, children: [p, ...target.children] }
            : { kind: 'group', op: 'and', children: [p, target] }
    return setAt(draft, into, next)
}

/** ``draft`` with the clause at ``path`` repeated right after itself. */
export function duplicateAt(draft: Predicate | null, path: Path): Predicate | null {
    const at = parentOf(path)
    const clause = getAt(draft, path)
    if (!at || !clause) return draft
    const group = at.into.length === 0 ? asRoot(draft) : getAt(draft, at.into)
    if (group?.kind !== 'group') return draft
    const children = [...group.children]
    children.splice(at.index + 1, 0, structuredClone(clause))
    return at.into.length === 0 ? collapseRoot({ ...group, children }) : setAt(draft, at.into, { ...group, children })
}

/** ``draft`` with the clause at ``path`` wrapped in a group of ``op`` —
 *  the start of "any of" / "none of". */
export function wrapAt(draft: Predicate | null, path: Path, op: 'and' | 'or' | 'not'): Predicate | null {
    const clause = getAt(draft, path)
    return clause ? setAt(draft, path, { kind: 'group', op, children: [clause] }) : draft
}

/** Where the clause at ``path`` sits: its group's path and its index. */
export function parentOf(path: Path): { into: Path; index: number } | null {
    const last = path[path.length - 1]
    if (!last || !('child' in last)) return null
    return { into: path.slice(0, -1), index: last.child }
}


// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/** A relationship's relative, as its line names it. */
export type Relative =
    /** "a Dashboard": the relative's type, from the first part of its
     *  condition — edited where it lives (``path``). */
    | { kind: 'types'; types: string[]; path: Path }
    /** Named entities — "CFO Revenue Dashboard", or "Sales or anything
     *  inside it" for a container question. */
    | { kind: 'names'; refs: NodeRef[]; path: Path; orInside: boolean }
    /** Any relative ("something"), or one described by the lines below. */
    | { kind: 'something' }

interface LineBase {
    key: string
    /** Indentation: 0 the subject, 1 its clauses, deeper inside groups and
     *  relationships. */
    depth: number
    /** The words before the clause: "that", "and", "or where"… */
    lead: string
    /** How many relationships this line sits inside. */
    relationDepth: number
    /** The listed clause this line is — its counts — when it is one (0:
     *  the subject, when there is one). */
    topIndex: number | null
    /** Its lead's first word is how the listed clauses combine: a token
     *  that switches them all between "and" and "or". */
    combines?: boolean
}

export type SentenceLine =
    | (LineBase & { kind: 'subject'; types: string[]; path: Path | null })
    | (LineBase & { kind: 'clause'; path: Path; predicate: Predicate; many: boolean })
    | (LineBase & { kind: 'relation'; path: Path; predicate: RelatedPredicate; relative: Relative; many: boolean })
    | (LineBase & { kind: 'group'; path: Path; op: 'and' | 'or' | 'not'; predicate: GroupPredicate })
    /** Where a new clause is added: the top-level clauses, a group, or a
     *  relationship's condition. */
    | (LineBase & { kind: 'add'; into: Path; joiner: 'and' | 'or' | 'that' })
    /** Nested past what the Sentence shows: edited in Code. */
    | (LineBase & { kind: 'code'; path: Path })

export interface Sentence {
    lines: SentenceLine[]
    /** How the listed clauses combine. */
    combine: 'and' | 'or'
}


/** The subject a query names: its first clause, when that is "type is …". */
function subjectOf(first: Predicate | undefined): string[] | null {
    return first?.kind === 'entityType' && (first.op ?? 'in') === 'in' ? first.values : null
}

/** Lead words: the first clause is joined by its connector, the rest by
 *  the group's operator — a verb clause needs no "that" after "and". */
function leadFor(p: Predicate, index: number, op: 'and' | 'or' | 'not', many: boolean): string {
    const conn = p.kind === 'group' && !isOrInside(p) ? 'that' : connector(p, many)
    if (index === 0) return conn
    const join = op === 'or' ? 'or' : 'and'
    return conn === 'where' ? `${join} where` : join
}

/** A relationship's condition, split into the relative its line names and
 *  the parts the lines below it show. */
function splitWhere(where: Predicate | null | undefined, wherePath: Path): {
    relative: Relative
    parts: Array<{ predicate: Predicate; path: Path }>
} {
    if (!where) return { relative: { kind: 'something' }, parts: [] }
    if (subjectOf(where)) return { relative: { kind: 'types', types: subjectOf(where)!, path: wherePath }, parts: [] }
    if (where.kind === 'is') return { relative: { kind: 'names', refs: where.refs, path: wherePath, orInside: false }, parts: [] }
    const inside = isOrInside(where)
    if (inside) return { relative: { kind: 'names', refs: inside, path: wherePath, orInside: true }, parts: [] }
    if (where.kind === 'group' && where.op === 'and') {
        const first = subjectOf(where.children[0])
        const parts = where.children.map((predicate, i) => ({ predicate, path: [...wherePath, { child: i }] }))
        return first
            ? { relative: { kind: 'types', types: first, path: [...wherePath, { child: 0 }] }, parts: parts.slice(1) }
            : { relative: { kind: 'something' }, parts }
    }
    return { relative: { kind: 'something' }, parts: [{ predicate: where, path: wherePath }] }
}


/** The query as a sentence lists it: its subject, the clauses after it,
 *  and how those combine. */
export interface ListedClauses {
    /** "Find [Datasets]": a first "type is …" clause of an all-of query. */
    subject: { types: string[]; predicate: Predicate } | null
    clauses: Array<{ predicate: Predicate; path: Path }>
    combine: 'and' | 'or'
    /** Where a clause added to the list goes. */
    into: Path
}

/** A subject's clauses combined by "any" are one any-of group after it —
 *  ``AND[subject, OR[…]]`` — and still listed as its clauses, so choosing
 *  "or" changes the words that join them, not the sentence's shape. */
export function listedClauses(draft: Predicate | null): ListedClauses {
    const root = asRoot(draft)
    const types = root.op === 'and' ? subjectOf(root.children[0]) : null
    if (!types) {
        return {
            subject: null,
            clauses: root.children.map((predicate, i) => ({ predicate, path: [{ child: i }] })),
            combine: root.op === 'or' ? 'or' : 'and',
            into: [],
        }
    }
    const rest = root.children.slice(1)
    const anyOf = rest.length === 1 && rest[0].kind === 'group' && rest[0].op === 'or' && !isOrInside(rest[0])
        ? rest[0] : null
    return {
        subject: { types, predicate: root.children[0] },
        clauses: anyOf
            ? anyOf.children.map((predicate, i) => ({ predicate, path: [{ child: 1 }, { child: i }] }))
            : rest.map((predicate, i) => ({ predicate, path: [{ child: i + 1 }] })),
        combine: anyOf ? 'or' : 'and',
        into: anyOf ? [{ child: 1 }] : [],
    }
}


/** ``draft`` with its listed clauses combined by ``op``. A subject stays
 *  first; its clauses combined by any become one any-of group after it. */
export function withCombine(draft: Predicate | null, op: 'and' | 'or'): Predicate | null {
    const { subject, clauses } = listedClauses(draft)
    const list = clauses.map((c) => c.predicate)
    if (list.length < 2) return draft
    if (!subject) return { kind: 'group', op, children: list }
    return { kind: 'group', op: 'and', children: [
        subject.predicate, ...(op === 'or' ? [{ kind: 'group', op: 'or', children: list } as Predicate] : list),
    ] }
}


/** ``draft`` finding ``types``: its subject replaced, dropped (none),
 *  or put first — clauses combined by any stay so, after it. */
export function withSubject(draft: Predicate | null, types: string[]): Predicate | null {
    const condition: Predicate = { kind: 'entityType', op: 'in', values: types }
    if (listedClauses(draft).subject) return setAt(draft, [{ child: 0 }], types.length ? condition : null)
    if (!types.length) return draft
    return draft?.kind === 'group' && draft.op === 'or'
        ? { kind: 'group', op: 'and', children: [condition, draft] }
        : prependAt(draft, [], condition)
}


export function buildSentence(draft: Predicate | null): Sentence {
    const { subject, clauses, combine, into } = listedClauses(draft)
    const lines: SentenceLine[] = []
    lines.push({
        kind: 'subject', key: 'subject', depth: 0, lead: 'Find', relationDepth: 0,
        topIndex: subject ? 0 : null, types: subject?.types ?? [], path: subject ? [{ child: 0 }] : null,
    })

    const emit = (p: Predicate, path: Path, depth: number, lead: string, relationDepth: number,
        many: boolean, topIndex: number | null, combines = false) => {
        const key = pathKey(path)
        const base = { key, depth, lead, relationDepth, topIndex, ...(combines ? { combines } : {}) }
        if (relationDepth > RELATION_DEPTH_MAX) {
            lines.push({ ...base, kind: 'code', path })
            return
        }
        if (p.kind === 'group' && !isOrInside(p)) {
            const op = p.op ?? 'and'
            lines.push({ ...base, kind: 'group', path, op, predicate: p })
            p.children.forEach((c, i) => emit(c, [...path, { child: i }], depth + 1,
                leadFor(c, i, op === 'not' ? 'or' : op, many), relationDepth, many, null))
            lines.push({ key: `${key}+`, depth: depth + 1, lead: '', relationDepth, topIndex: null,
                kind: 'add', into: path, joiner: op === 'and' ? 'and' : 'or' })
            return
        }
        if (p.kind === 'related') {
            const wherePath: Path = [...path, { where: true }]
            const { relative, parts } = splitWhere(p.where, wherePath)
            lines.push({ ...base, kind: 'relation', path, predicate: p, relative, many })
            // The relative is one, or — every one, a count of them — several.
            const several = p.count ? p.count.value !== 1 : p.quantifier === 'all'
            parts.forEach((part, i) => emit(part.predicate, part.path, depth + 1,
                i === 0 ? `↳ ${connector(part.predicate, several)}` : leadFor(part.predicate, i, 'and', several),
                relationDepth + 1, several, null))
            // Named relatives are what they are named: nothing to add to.
            if (relationDepth + 1 <= RELATION_DEPTH_MAX && relative.kind !== 'names') {
                lines.push({ key: `${key}+`, depth: depth + 1, lead: '', relationDepth: relationDepth + 1,
                    topIndex: null, kind: 'add', into: wherePath, joiner: 'that' })
            }
            return
        }
        lines.push({ ...base, kind: 'clause', path, predicate: p, many })
    }

    // "Find Datasets that are tagged", "Find anything that is tagged".
    const offset = subject ? 1 : 0
    const many = !!subject
    clauses.forEach(({ predicate, path }, k) => {
        emit(predicate, path, 1, leadFor(predicate, k, combine, many), 0, many, offset + k, k > 0)
    })
    lines.push({ key: 'root+', depth: 1, lead: '', relationDepth: 0, topIndex: null,
        kind: 'add', into, joiner: combine })
    return { lines, combine }
}
