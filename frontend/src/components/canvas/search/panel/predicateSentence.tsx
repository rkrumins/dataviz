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
import type { GroupPredicate, Predicate } from '@/types/search'


// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export interface SentenceOptions {
    /** First word — defaults to "Show me entities". Keeps room for a
     *  future "Find" / "List" variant. */
    leadIn?: string
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
    return renderTop(predicate, leadIn)
}


// ---------------------------------------------------------------------------
// Top-level (decides the framing sentence)
// ---------------------------------------------------------------------------

function renderTop(p: Predicate, leadIn: string): ReactNode {
    if (p.kind !== 'group') {
        return (
            <p>
                {leadIn} where <Inline>{leafSentence(p)}</Inline>.
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
                        {leadIn} that <strong className="text-rose-300">do NOT</strong>{' '}
                        match {innerOp === 'or' ? 'any of:' : 'all of:'}
                    </p>
                    <BulletList items={inner.children.map((c) => renderInner(c, /*indent*/ 1))} />
                </div>
            )
        }
        return (
            <p>
                {leadIn} that <strong className="text-rose-300">do NOT</strong>{' '}
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
        return renderTop(p.children[0], leadIn)
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

/**
 * Render one predicate leaf as a natural-language phrase fragment.
 * Returns a fragment so the caller composes it inside its own
 * sentence ("their **name contains 't2'**").
 */
function leafSentence(p: Predicate): ReactNode {
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
                op === 'hasAll' ? 'tagged with all of'
                    : op === 'notHas' ? 'NOT tagged with'
                        : 'tagged'
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
        case 'hasProperty':
            return p.negate
                ? <>does not have a <Value>{p.key}</Value> property</>
                : <>has a <Value>{p.key}</Value> property</>
        case 'property': {
            const op = p.op ?? 'eq'
            const verb =
                op === 'eq' ? 'equals'
                    : op === 'neq' ? 'does not equal'
                        : op === 'gt' ? 'is greater than'
                            : op === 'gte' ? 'is at least'
                                : op === 'lt' ? 'is less than'
                                    : op === 'lte' ? 'is at most'
                                        : op === 'in' ? 'is one of'
                                            : op === 'notIn' ? 'is not one of'
                                                : op === 'contains' ? 'contains'
                                                    : op === 'startsWith' ? 'starts with'
                                                        : op === 'endsWith' ? 'ends with'
                                                            : op === 'between' ? 'is between'
                                                                : op
            return (
                <>
                    <Value>{p.key}</Value> {verb}{' '}
                    <Value>{formatValue(p.value)}</Value>
                </>
            )
        }
        case 'isRoot':       return <>has no upstream lineage</>
        case 'isLeaf':       return <>has no downstream lineage</>
        case 'isOrphan':     return <>has no lineage edges</>
        case 'hasIncoming':  return <>has incoming lineage edges</>
        case 'hasOutgoing':  return <>has outgoing lineage edges</>
        case 'descendantOf':
            return <>is inside {p.urns.length === 1
                ? <Value>{formatUrnLabel(p.urns[0])}</Value>
                : <><Value>{p.urns.length}</Value> subtrees</>}</>
        case 'withinHops': {
            const dirText =
                p.direction === 'in' ? 'upstream of'
                    : p.direction === 'out' ? 'downstream of'
                        : 'within'
            return <>is ≤ {p.hops} hop{p.hops === 1 ? '' : 's'} {dirText} <Value>{p.urns[0] ?? '…'}</Value></>
        }
        case 'path':
            return <>lies on a path from <Value>{p.sourceUrns[0] ?? '…'}</Value> to <Value>{p.targetUrns[0] ?? '…'}</Value> (≤ {p.maxHops} hops)</>
        case 'degree':
            return <>has {p.direction ?? 'any'} edges {p.op} {p.value}</>
        case 'group':
            return <>(nested group)</>
        default:
            return <>(unknown filter)</>
    }
}


function formatValue(v: unknown): string {
    if (v === null || v === undefined) return '∅'
    if (Array.isArray(v)) return v.map(formatValue).join(', ')
    if (typeof v === 'string') return v
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    return JSON.stringify(v)
}


// ---------------------------------------------------------------------------
// Tiny presentation primitives
// ---------------------------------------------------------------------------

function Inline({ children }: { children: ReactNode }) {
    return <span className="leading-relaxed">{children}</span>
}


function Value({ children }: { children: ReactNode }) {
    return (
        <span className={cn(
            'inline-flex items-center px-1.5 py-0',
            'rounded font-mono text-[11.5px]',
            'bg-canvas-elevated/70 border border-glass-border/60',
            'text-ink',
        )}>
            {typeof children === 'string' ? `"${children}"` : children}
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
