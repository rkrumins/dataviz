/**
 * predicateSentence — render a predicate tree as plain English JSX so
 * non-technical users can read what their query actually does without
 * having to mentally translate AND/OR/NOT and nested card structure.
 *
 * Output structure (indented bullets reflect tree depth):
 *
 *   Show me entities where any of these is true:
 *     • their name contains "t2"
 *       AND (their name contains "account" OR their name contains "opp")
 *     • their name contains "T1"
 *       AND their name contains "contacts"
 *
 *   Show me entities that do NOT match any of:
 *     • Name contains "T1"
 *     • Name contains "SILVER"
 *
 *   (Single-leaf:)
 *     Show me entities where name contains "t2".
 *
 * Pure presentation — never mutates the predicate tree. Mounted by
 * WhatThisMeansDisclosure.
 */
import { type ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { formatUrnLabel } from '@/lib/urnLabels'
import type {
    EdgePredicateNode,
    EdgePropertyPredicate,
    GroupPredicate,
    NodeRef,
    Predicate,
    PropertyPredicate,
    RelatedPredicate,
} from '@/types/search'

import { arityOf, isNegative, operatorLabel, predicateType } from '../typed/operators'
import { describeDuration } from '../typed/valueCodec'

import { axisMeta, hopRange, refLabel } from './relations'


// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export interface SentenceOptions {
    /** First word — defaults to "Show me entities". Keeps room for a
     *  future "Find" / "List" variant. */
    leadIn?: string
    /** The lead-in names one thing ("Anything"), so the verb after it
     *  agrees: "Anything that has…", not "…that have…". */
    singular?: boolean
}


export function formatPredicateAsSentence(
    predicate: Predicate | null,
    opts: SentenceOptions = {},
): ReactNode {
    const leadIn = opts.leadIn ?? 'Show me entities'
    if (!predicate) {
        return (
            <p className="text-ink-muted/85">
                {leadIn} — <em>no filters yet</em>. Add a condition to start.
            </p>
        )
    }
    return renderTop(predicate, leadIn, !opts.singular)
}


// ---------------------------------------------------------------------------
// Top-level (decides the framing sentence)
// ---------------------------------------------------------------------------

function renderTop(p: Predicate, leadIn: string, many: boolean): ReactNode {
    if (p.kind !== 'group') {
        return (
            <p>
                {leadIn} {connector(p, many)} <Inline>{leafSentence(p, many)}</Inline>.
            </p>
        )
    }
    const op = p.op ?? 'and'
    if (op === 'not') {
        // NOT at top level — invert the whole tree.
        const inner = p.children[0]
        if (!inner) {
            return (
                <p>
                    {leadIn} — <em>empty NOT</em>. Add a condition to invert.
                </p>
            )
        }
        if (inner.kind === 'group') {
            // NOT(group) — flatten the inner ANY-of / ALL-of list.
            const innerOp = inner.op ?? 'and'
            return (
                <div>
                    <p>
                        {leadIn} that <strong className="text-rose-300">{many ? 'do' : 'does'} NOT</strong>{' '}
                        match {innerOp === 'or' ? 'any of:' : 'all of:'}
                    </p>
                    <BulletList items={inner.children.map((c) => renderInner(c, /*indent*/ 1))} />
                </div>
            )
        }
        return (
            <p>
                {leadIn} that <strong className="text-rose-300">{many ? 'do' : 'does'} NOT</strong>{' '}
                match <Inline>{leafSentence(inner)}</Inline>.
            </p>
        )
    }
    if (!p.children.length) {
        return (
            <p>
                {leadIn} — <em>empty {op === 'or' ? 'ANY' : 'ALL'} group</em>.
            </p>
        )
    }
    if (p.children.length === 1) {
        // Single-child group is functionally a leaf — descend.
        return renderTop(p.children[0], leadIn, many)
    }
    const lead = op === 'or'
        ? <>where <strong className="text-amber-300">any</strong> of these is true:</>
        : <>where <strong className="text-accent-lineage">all</strong> of these are true:</>
    return (
        <div>
            <p>{leadIn} {lead}</p>
            <BulletList items={p.children.map((c) => renderInner(c, /*indent*/ 1))} />
        </div>
    )
}


// ---------------------------------------------------------------------------
// Inner rendering (a single bullet item — may itself nest)
// ---------------------------------------------------------------------------

function renderInner(p: Predicate, depth: number): ReactNode {
    if (p.kind !== 'group') {
        return <Inline>{leafSentence(p)}</Inline>
    }
    const op = p.op ?? 'and'
    if (op === 'not') {
        const inner = p.children[0]
        if (!inner) return <Inline><em>empty NOT group</em></Inline>
        // NOT(leaf) → "NOT name contains 'x'"
        if (inner.kind !== 'group') {
            return (
                <Inline>
                    <strong className="text-rose-300">NOT</strong>{' '}
                    {leafSentence(inner)}
                </Inline>
            )
        }
        // NOT(group) at depth — show as inline phrase then nested list
        const innerOp = inner.op ?? 'and'
        return (
            <div>
                <Inline>
                    <strong className="text-rose-300">NOT</strong>{' '}
                    {innerOp === 'or' ? 'any of' : 'all of'}:
                </Inline>
                <BulletList items={inner.children.map((c) => renderInner(c, depth + 1))} />
            </div>
        )
    }
    if (!p.children.length) {
        return <Inline><em>empty {op === 'or' ? 'ANY' : 'ALL'} group</em></Inline>
    }
    if (p.children.length === 1) return renderInner(p.children[0], depth)
    const inside = isOrInside(p)
    if (inside) return <Inline>{isOrInsideSentence(inside)}</Inline>
    // 2+ children — render as inline conjunction when all children are
    // leaves (keeps single-clause bullets compact); otherwise break
    // into a nested bullet list.
    const allLeaves = p.children.every((c) => c.kind !== 'group')
    if (allLeaves) {
        return inlineConjunction(p as GroupPredicate)
    }
    // Mixed nesting — break out into a sub-list with a label line.
    const headerOp = op === 'or'
        ? <strong className="text-amber-300">any</strong>
        : <strong className="text-accent-lineage">all</strong>
    return (
        <div>
            <Inline>{headerOp} of:</Inline>
            <BulletList items={p.children.map((c) => renderInner(c, depth + 1))} />
        </div>
    )
}


/**
 * Render a flat (all-leaves) AND/OR group as a single inline phrase
 * with the connective coloured. Handles arbitrary number of children.
 */
function inlineConjunction(g: GroupPredicate): ReactNode {
    const op = g.op ?? 'and'
    const connective = op === 'or'
        ? <strong className="text-amber-300"> OR </strong>
        : <strong className="text-accent-lineage"> AND </strong>
    const parts: ReactNode[] = []
    g.children.forEach((c, i) => {
        if (i > 0) parts.push(<span key={`c-${i}`}>{connective}</span>)
        parts.push(<span key={`l-${i}`}>{leafSentence(c)}</span>)
    })
    // Wrap in parens when the group is nested in a different op (the
    // caller decides whether to print parens by reading the visual
    // tree; we keep it simple here and always wrap multi-child inline
    // conjunctions).
    return (
        <Inline>
            <span className="text-ink-muted/85">(</span>
            {parts}
            <span className="text-ink-muted/85">)</span>
        </Inline>
    )
}


// ---------------------------------------------------------------------------
// Leaf → English phrase
// ---------------------------------------------------------------------------

/** Clauses that begin with a verb — "has a parent", "is inside Finance",
 *  "is tagged …" — follow "that"; the rest name an attribute ("type is
 *  dataset") and follow "where". */
const VERB_CLAUSES = new Set<string>([
    'tag', 'hasProperty', 'isRoot', 'isLeaf', 'isOrphan', 'hasIncoming', 'hasOutgoing',
    'descendantOf', 'withinHops', 'path', 'is', 'related', 'degree',
])

/** The word joining a condition to what it describes. A group of verb
 *  clauses reads "that (is inside X AND has a source)" — unless it
 *  describes several, whose verbs it can't make agree. */
function connector(p: Predicate, many = false): 'that' | 'where' {
    if (p.kind === 'group') {
        const verbs = (p.op ?? 'and') !== 'not' && p.children.length > 0
            && p.children.every((c) => connector(c) === 'that')
        return verbs && (!many || p.children.length === 1) ? 'that' : 'where'
    }
    return p.kind && VERB_CLAUSES.has(p.kind) ? 'that' : 'where'
}

const ONE = { has: 'has', is: 'is', does: 'does', lies: 'lies' }
const MANY = { has: 'have', is: 'are', does: 'do', lies: 'lie' }


/**
 * Render one predicate leaf as a natural-language phrase fragment.
 * Returns a fragment so the caller composes it inside its own
 * sentence ("their **name contains 't2'**"). ``many``: it describes
 * several entities, so its verb agrees ("have a parent").
 */
function leafSentence(p: Predicate, many = false): ReactNode {
    const v = many ? MANY : ONE
    switch (p.kind) {
        case 'text': {
            const target = p.target ?? 'name'
            const op = p.match ?? 'substring'
            const field =
                target === 'name' ? 'name'
                    : target === 'qualifiedName' ? 'qualified name'
                        : target === 'description' ? 'description'
                            : target === 'tags' ? 'tags'
                                : target === 'any' ? 'any text field'
                                    : target
            const verb =
                op === 'exact' ? 'is exactly'
                    : op === 'prefix' ? 'starts with'
                        : op === 'suffix' ? 'ends with'
                            : 'contains'
            return (
                <>
                    {field} {verb} <Value>{p.value}</Value>
                </>
            )
        }
        case 'entityType': {
            const verb = p.op === 'notIn' ? 'is not' : 'is'
            return (
                <>
                    type {verb} {p.values.length === 1
                        ? <Value>{p.values[0]}</Value>
                        : <>one of {p.values.map((v, i) => (
                            <span key={v}>
                                {i > 0 && ' / '}<Value>{v}</Value>
                            </span>
                        ))}</>}
                </>
            )
        }
        case 'tag': {
            const op = p.op ?? 'hasAny'
            const verb =
                op === 'hasAll' ? `${v.is} tagged with all of`
                    : op === 'notHas' ? `${v.is} NOT tagged with`
                        : `${v.is} tagged`
            return (
                <>
                    {verb} {p.values.map((v, i) => (
                        <span key={v}>
                            {i > 0 && ', '}<Value>#{v}</Value>
                        </span>
                    ))}
                </>
            )
        }
        case 'layer':
            return <>layer is <Value>{p.layerAssignment}</Value></>
        case 'hasProperty': {
            const has = p.negate ? `${v.does} not have` : v.has
            if (p.keyMatch === 'prefix' || p.keyMatch === 'contains') {
                return <>{has} a property whose name {p.keyMatch === 'prefix' ? 'starts with' : 'contains'} <Value>{p.key}</Value></>
            }
            return <>{has} a <Value>{p.key}</Value> property</>
        }
        case 'property': {
            const op = p.op ?? 'eq'
            const arity = arityOf(op)
            const type = predicateType(p)
            return (
                <>
                    <Value>{p.key}</Value> {operatorLabel(op, type)}
                    {arity === 'duration' && <> <Value quoted={false}>{describeDuration(p.value) ?? '…'}</Value></>}
                    {arity !== 'none' && arity !== 'duration' && (
                        <>{' '}<PropertyValue value={p.value} between={op === 'between'}
                                              bare={BARE_TYPES.has(type) && !TEXT_OPS.has(op)} /></>
                    )}
                    {p.caseSensitive && arity !== 'none' && <span className="text-ink-muted"> (match case)</span>}
                    {p.includeMissing && isNegative(op) && <span className="text-ink-muted"> (or not set)</span>}
                </>
            )
        }
        case 'isRoot':       return <>{v.has} no upstream lineage</>
        case 'isLeaf':       return <>{v.has} no downstream lineage</>
        case 'isOrphan':     return <>{v.has} no lineage edges</>
        case 'hasIncoming':  return <>{v.has} incoming lineage edges</>
        case 'hasOutgoing':  return <>{v.has} outgoing lineage edges</>
        case 'descendantOf': {
            const anchors = named(p.urns, p.refs)
            return <>{v.is} inside {anchors.length === 1
                ? <Value>{anchors[0]}</Value>
                : <><Value>{anchors.length}</Value> subtrees</>}</>
        }
        case 'withinHops': {
            const dirText =
                p.direction === 'in' ? 'upstream of'
                    : p.direction === 'out' ? 'downstream of'
                        : 'within'
            return <>{v.is} ≤ {p.hops} hop{p.hops === 1 ? '' : 's'} {dirText} <Value>{named(p.urns, p.refs)[0] ?? '…'}</Value></>
        }
        case 'path': {
            const end = (urns?: string[] | null, refs?: NodeRef[] | null, where?: Predicate | null) => {
                if (where) return <>anything {connector(where)} {leafOrGroup(where)}</>
                const names = named(urns, refs)
                return names.length > 1
                    ? <>any of {names.map((n, i) => <span key={i}>{i > 0 && ', '}<Value>{n}</Value></span>)}</>
                    : <Value>{names[0] ?? '…'}</Value>
            }
            return <>{v.lies} on a route from {end(p.sourceUrns, p.sourceRefs, p.sourceWhere)} to {end(p.targetUrns, p.targetRefs, p.targetWhere)} (up to {p.maxHops ?? 4} hops)</>
        }
        case 'is': {
            const names = named([], p.refs)
            return names.length === 1
                ? <>{v.is} <Value>{names[0]}</Value></>
                : <>{v.is} one of {names.map((n, i) => <span key={i}>{i > 0 && ', '}<Value>{n}</Value></span>)}</>
        }
        case 'related':
            return relationSentence(p, many)
        case 'degree':
            return <>{v.has} {p.direction ?? 'any'} edges {p.op} {p.value}</>
        case 'all':
            return <>every entity is included</>
        case 'group':
            return <>(nested group)</>
        default:
            return <>(unknown filter)</>
    }
}


/** The entities an end names: its URNs' labels, then its names. */
function named(urns?: string[] | null, refs?: NodeRef[] | null): string[] {
    return [...(urns ?? []).map((u) => formatUrnLabel(u)), ...(refs ?? []).map(refLabel)]
}


function leafOrGroup(p: Predicate, many = false): ReactNode {
    if (p.kind !== 'group') return leafSentence(p, many)
    const inside = isOrInside(p)
    return inside ? isOrInsideSentence(inside, many) : renderInner(p, 1)
}


/** The names in "is X or inside X" — what a lineage question about a
 *  container asks of a relative — or null for any other condition. */
function isOrInside(p: Predicate): NodeRef[] | null {
    if (p.kind !== 'group' || p.op !== 'or' || p.children.length !== 2) return null
    const is = p.children.find((c) => c.kind === 'is')
    const inside = p.children.find((c) => c.kind === 'related')
    if (is?.kind !== 'is' || inside?.kind !== 'related' || inside.axis !== 'ancestor'
        || inside.count || (inside.quantifier ?? 'any') !== 'any'
        || inside.minHops || inside.maxHops || inside.where?.kind !== 'is') return null
    return JSON.stringify(inside.where.refs) === JSON.stringify(is.refs) ? is.refs : null
}


/** "is or is inside VBAP" — "are or are inside …" when it describes several. */
function isOrInsideSentence(refs: NodeRef[], many = false): ReactNode {
    const v = many ? MANY : ONE
    const names = named([], refs)
    return <>{v.is} or {v.is} inside {names.length === 1
        ? <Value>{names[0]}</Value>
        : <>one of {names.map((n, i) => <span key={i}>{i > 0 && ', '}<Value>{n}</Value></span>)}</>}</>
}


const COUNT_WORDS: Record<string, string> = {
    eq: 'exactly', neq: 'other than', gt: 'more than', gte: 'at least', lt: 'fewer than',
    lte: 'at most',
}


/** "has a parent where type is domain", "has a parent that is Finance",
 *  "has no source within 3 hops", "has children, every one where …",
 *  "has more than 100 children that have …" — the relative named for
 *  what it is, never in or out. The edges walked come last: "has a target
 *  that is X, through edges where …". */
function relationSentence(p: RelatedPredicate, many = false): ReactNode {
    const v = many ? MANY : ONE
    const meta = axisMeta(p.axis)
    const [lo, hi] = hopRange(p)
    const span = lo === hi ? `${hi}` : `${lo}–${hi}`
    const reach = meta.lineage
        ? (hi > 1 ? <> within {span} hops</> : null)
        : meta.hops && (p.minHops || p.maxHops) ? <> {span} levels away</> : null
    // After a condition, a comma keeps the edges from reading as part of it.
    const via = p.edge
        ? <>{p.where ? ',' : ''} through edges where {edgeSentence(p.edge)}</> : null
    const cond = (several = false) => p.where
        ? <> {connector(p.where, several)} {leafOrGroup(p.where, several)}</> : null
    if (p.count) {
        const n = p.count.value
        return <>{v.has} {COUNT_WORDS[p.count.op ?? 'gte']} <Value quoted={false}>{n}</Value>{' '}
            {n === 1 ? meta.noun : meta.plural}{reach}{cond(n !== 1)}{via}</>
    }
    if (p.quantifier === 'none') return <>{v.has} <strong className="text-rose-300">no</strong> {meta.noun}{reach}{cond()}{via}</>
    if (p.quantifier === 'all' && p.where) {
        const every = <strong className="text-accent-lineage">every one</strong>
        // "…, every one where type is column"; a verb reads "…, and every one is inside X".
        return connector(p.where) === 'that'
            ? <>{v.has} {meta.plural}{reach}, and {every} {leafOrGroup(p.where)}{via}</>
            : <>{v.has} {meta.plural}{reach}, {every}{cond()}{via}</>
    }
    return <>{v.has} a{/^[aeiou]/.test(meta.noun) ? 'n' : ''} {meta.noun}{reach}{cond()}{via}</>
}


function edgeSentence(ep: EdgePredicateNode): ReactNode {
    if (ep.kind === 'edgeGroup') {
        if (ep.op === 'not') return <><strong className="text-rose-300">NOT</strong> {edgeSentence(ep.children[0])}</>
        const join = ep.op === 'or' ? ' or ' : ' and '
        return <>{ep.children.map((c, i) => <span key={i}>{i > 0 && join}{edgeSentence(c)}</span>)}</>
    }
    if (ep.kind === 'edgeHasProperty') {
        return <>{ep.negate ? 'there is no' : 'there is a'} <Value>{ep.key}</Value></>
    }
    const prop = ep as EdgePropertyPredicate
    const op = prop.op ?? 'eq'
    const arity = arityOf(op)
    const type = predicateType({ ...prop, kind: 'property' } as PropertyPredicate)
    return (
        <>
            <Value>{prop.key}</Value> {operatorLabel(op, type)}
            {arity !== 'none' && arity !== 'duration' && (
                <>{' '}<PropertyValue value={prop.value} between={op === 'between'}
                                      bare={BARE_TYPES.has(type) && !TEXT_OPS.has(op)} /></>
            )}
        </>
    )
}


/** Compared as these, a value reads bare — unless the operator reads its
 *  text ("contains 74" means the digits). */
const BARE_TYPES = new Set(['number', 'boolean'])
const TEXT_OPS = new Set(['contains', 'notContains', 'startsWith', 'endsWith'])


/** A property value as the query will compare it: text quoted, numbers and
 *  booleans bare, a list as its items, a range as both ends, and an empty
 *  value as a gap waiting to be filled — never as `""`, which read as "equals
 *  the empty string". */
function PropertyValue({ value, between, bare }: {
    value: unknown
    between?: boolean
    /** A number or true/false: bare even when it travels as text (a 64-bit
     *  integer does, to keep its digits). */
    bare?: boolean
}) {
    const one = (v: unknown, key?: number) => {
        if (v === null || v === undefined || v === '') {
            return <span key={key} className="text-ink-muted">…</span>
        }
        if (typeof v === 'string') return <Value key={key} quoted={!bare}>{v}</Value>
        return <Value key={key} quoted={false}>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</Value>
    }
    if (!Array.isArray(value)) return one(value)
    if (between) return <>{one(value[0], 0)} and {one(value[1], 1)}</>
    if (value.length === 0) return one(undefined)
    return <>{value.map((v, i) => <span key={i}>{i > 0 && ', '}{one(v)}</span>)}</>
}


// ---------------------------------------------------------------------------
// Tiny presentation primitives
// ---------------------------------------------------------------------------

function Inline({ children }: { children: ReactNode }) {
    return <span className="leading-relaxed">{children}</span>
}


function Value({ children, quoted }: { children: ReactNode; quoted?: boolean }) {
    return (
        <span className={cn(
            'inline-flex items-center px-1.5 py-0',
            'rounded font-mono text-[11.5px]',
            'bg-canvas-elevated/70 border border-glass-border/60',
            'text-ink',
        )}>
            {(quoted ?? typeof children === 'string') ? `"${children}"` : children}
        </span>
    )
}


function BulletList({ items }: { items: ReactNode[] }) {
    return (
        <ul className="mt-1.5 ml-3 flex flex-col gap-1.5">
            {items.map((node, i) => (
                <li key={i} className="flex items-start gap-2">
                    <span className="mt-1.5 inline-block w-1 h-1 rounded-full bg-ink-muted/60 shrink-0" />
                    <div className="flex-1 min-w-0">{node}</div>
                </li>
            ))}
        </ul>
    )
}
