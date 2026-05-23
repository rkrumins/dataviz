/**
 * QueryChips — renders a `Predicate` as a row of human-readable chips.
 *
 * Used in the "active query" card on the AskBar so a business user can
 * see what their natural-language question (or template) was interpreted
 * as, without having to read JSON or open the builder. AND-groups flatten
 * into peer chips; OR/NOT groups render as a single composite chip so
 * the boolean structure is preserved.
 *
 * Leaf chip vocabulary is a thin map over the predicate kind; we
 * deliberately don't reuse `leafKinds.ts` labels because those are
 * picker-oriented ("Property value") whereas chips need a value-ful
 * read ("rowCount > 1000").
 */
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { cn } from '@/lib/utils'
import type { Predicate } from '@/types/search'


export interface QueryChipsProps {
    predicate: Predicate
    /** Visual size — `sm` is the default; `xs` for compact in-row use. */
    size?: 'sm' | 'xs'
}


export function QueryChips({ predicate, size = 'sm' }: QueryChipsProps) {
    const chips = flattenToChips(predicate)
    if (chips.length === 0) return null

    return (
        <div className="flex flex-wrap items-center gap-1.5">
            {chips.map((chip, i) => (
                <span
                    key={i}
                    className={cn(
                        'inline-flex items-center gap-1 rounded-md',
                        'bg-accent-lineage/12 border border-accent-lineage/25',
                        'text-accent-lineage font-medium tabular-nums',
                        size === 'xs'
                            ? 'px-1.5 py-0.5 text-[10px]'
                            : 'px-2 py-1 text-[11px]',
                    )}
                    title={chip.title ?? chip.label}
                >
                    {chip.icon && (
                        <DynamicIcon
                            name={chip.icon}
                            className={size === 'xs' ? 'w-2.5 h-2.5' : 'w-3 h-3'}
                        />
                    )}
                    {chip.label}
                </span>
            ))}
        </div>
    )
}


interface Chip {
    label: string
    icon?: string
    title?: string
}


/**
 * Walk the predicate tree, flattening top-level AND-groups into peer
 * chips. OR / NOT groups render as a single composite chip that
 * preserves the boolean operator so the user can see "(A or B)".
 */
function flattenToChips(p: Predicate): Chip[] {
    if (p.kind === 'group' && p.op === 'and') {
        return p.children.flatMap(flattenToChips)
    }
    return [describePredicate(p)]
}


function describePredicate(p: Predicate): Chip {
    // The generated predicate types all have ``kind?:`` — TS can't
    // narrow on an optional field, so we route through the (always-set)
    // kind via a discriminating helper.
    switch (p.kind) {
        case 'text': {
            const tgt = p.target === 'any' ? 'anywhere' : (p.target ?? 'anywhere')
            return {
                icon: 'Search',
                label: `"${truncate(p.value)}" in ${tgt}`,
            }
        }

        case 'property': {
            const op = (p.op && PROP_OP_LABEL[p.op]) || p.op || '='
            return {
                icon: 'SlidersHorizontal',
                label: `${p.key} ${op} ${valueLabel(p.value)}`,
            }
        }

        case 'hasProperty':
            return {
                icon: 'KeyRound',
                label: p.negate ? `no ${p.key}` : `has ${p.key}`,
            }

        case 'tag': {
            const verb = (p.op && TAG_OP_LABEL[p.op]) || 'tagged'
            return {
                icon: 'Tag',
                label: `${verb} ${p.values.map((v) => `#${v}`).join(', ')}`,
            }
        }

        case 'entityType': {
            const verb = p.op === 'notIn' ? 'not' : ''
            return {
                icon: 'Boxes',
                label: `${verb} type: ${p.values.join(' / ')}`.trim(),
            }
        }

        case 'layer':
            return { icon: 'Layers', label: `layer = ${p.layerAssignment}` }

        case 'isOrphan':
            return { icon: 'Unplug', label: 'no edges' }

        case 'isLeaf':
            return { icon: 'CircleArrowRight', label: 'dead-end' }

        case 'isRoot':
            return { icon: 'CircleArrowLeft', label: 'source' }

        case 'hasIncoming':
            return { icon: 'ArrowDownToLine', label: 'has incoming' }

        case 'hasOutgoing':
            return { icon: 'ArrowUpFromLine', label: 'has outgoing' }

        case 'degree': {
            const opLabel = (p.op && DEGREE_OP_LABEL[p.op]) || p.op || '='
            const dir = p.direction === 'both' || !p.direction
                ? 'edges'
                : `${p.direction} edges`
            return {
                icon: 'GitBranchPlus',
                label: `${dir} ${opLabel} ${p.value}`,
            }
        }

        case 'descendantOf':
            return {
                icon: 'FolderTree',
                label: `inside ${p.urns.length === 1 ? truncateUrn(p.urns[0]) : `${p.urns.length} subtrees`}`,
                title: p.urns.join('\n'),
            }

        case 'withinHops':
            return {
                icon: 'Waypoints',
                label: `≤${p.hops} hop${p.hops === 1 ? '' : 's'} ${p.direction === 'both' || !p.direction ? 'around' : p.direction === 'in' ? 'upstream of' : 'downstream of'} ${truncateUrn(p.urns[0] ?? '')}`,
                title: p.urns.join('\n'),
            }

        case 'path':
            return {
                icon: 'GitFork',
                label: `paths ${truncateUrn(p.sourceUrns[0] ?? '')} → ${truncateUrn(p.targetUrns[0] ?? '')} (≤${p.maxHops}h)`,
                title: `${p.sourceUrns.join(', ')}\n→\n${p.targetUrns.join(', ')}`,
            }

        case 'group': {
            // op is 'or' or 'not' here ('and' is flattened upstream)
            const childLabels = p.children.map((c) => describePredicate(c).label)
            if (p.op === 'not') {
                return {
                    icon: 'Ban',
                    label: `not (${childLabels.join(', ')})`,
                }
            }
            return {
                icon: 'GitMerge',
                label: childLabels.join(' OR '),
            }
        }
    }
    // Fallback for predicates without an explicit kind tag — should be
    // unreachable with valid data, but keeps the function total in TS's
    // eyes since the generated union has `kind?:` as optional.
    return { icon: 'AlertCircle', label: 'unknown' }
}


const PROP_OP_LABEL: Record<string, string> = {
    eq: '=',
    neq: '≠',
    gt: '>',
    gte: '≥',
    lt: '<',
    lte: '≤',
    in: 'in',
    notIn: 'not in',
    contains: 'contains',
    startsWith: 'starts with',
    endsWith: 'ends with',
    between: 'between',
}

const TAG_OP_LABEL: Record<string, string> = {
    has: 'tagged',
    hasAll: 'tagged all',
    hasAny: 'tagged any',
    notHas: 'not tagged',
}

const DEGREE_OP_LABEL: Record<string, string> = {
    eq: '=',
    neq: '≠',
    gt: '>',
    gte: '≥',
    lt: '<',
    lte: '≤',
}


function truncate(s: string, n = 24): string {
    return s.length > n ? `${s.slice(0, n)}…` : s
}

function truncateUrn(urn: string, n = 18): string {
    if (!urn) return '∅'
    // Show the suffix — that's usually the distinguishing part of a URN.
    if (urn.length <= n) return urn
    const tail = urn.split(':').pop() ?? urn
    return tail.length <= n ? tail : `…${tail.slice(-n + 1)}`
}

function valueLabel(v: unknown): string {
    if (v === null || v === undefined) return '∅'
    if (Array.isArray(v)) return `[${v.map(valueLabel).join(', ')}]`
    if (typeof v === 'string') return v.length > 24 ? `"${v.slice(0, 24)}…"` : `"${v}"`
    return String(v)
}
