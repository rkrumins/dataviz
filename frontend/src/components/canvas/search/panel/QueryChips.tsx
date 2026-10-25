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
import { formatUrnLabel } from '@/lib/urnLabels'
import type { NodeRef, Predicate } from '@/types/search'

import { arityOf } from '../typed/operators'
import { describeDuration } from '../typed/valueCodec'

import { axisMeta, hopRange, refLabel, throughOf } from './relations'
import { degreePhrase, edgeSetPhrase, shapeLabel } from './vocabulary/edgeWords'


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
            const op = p.op ?? 'eq'
            const arity = arityOf(op)
            const value = arity === 'none' ? ''
                : arity === 'duration' ? ` ${describeDuration(p.value) ?? '…'}`
                    : ` ${valueLabel(p.value)}`
            return {
                icon: 'SlidersHorizontal',
                label: `${p.key} ${PROP_OP_LABEL[op] ?? op}${value}`,
            }
        }

        case 'hasProperty': {
            const name = p.keyMatch === 'contains' ? `*${p.key}*`
                : p.keyMatch === 'prefix' ? `${p.key}*` : p.key
            return {
                icon: 'KeyRound',
                label: p.negate ? `no ${name}` : `has ${name}`,
            }
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
            return { icon: 'Unplug', label: shapeLabel(p.kind, p).toLowerCase() }

        case 'isLeaf':
            return { icon: 'CircleArrowRight', label: shapeLabel(p.kind, p).toLowerCase() }

        case 'isRoot':
            return { icon: 'CircleArrowLeft', label: shapeLabel(p.kind, p).toLowerCase() }

        case 'hasIncoming':
            return { icon: 'ArrowDownToLine', label: shapeLabel(p.kind, p).toLowerCase() }

        case 'hasOutgoing':
            return { icon: 'ArrowUpFromLine', label: shapeLabel(p.kind, p).toLowerCase() }

        case 'degree':
            return { icon: 'GitBranchPlus', label: degreePhrase(p) }

        case 'descendantOf': {
            const anchors = named(p.urns, p.refs)
            return {
                icon: 'FolderTree',
                label: `inside ${anchors.length === 1 ? anchors[0] : `${anchors.length} subtrees`}`,
                title: anchors.join('\n'),
            }
        }

        case 'withinHops':
            return {
                icon: 'Waypoints',
                label: `≤${p.hops} hop${p.hops === 1 ? '' : 's'} ${p.direction === 'both' || !p.direction ? 'around' : p.direction === 'in' ? 'upstream of' : 'downstream of'} ${named(p.urns, p.refs)[0] ?? '∅'}`,
                title: named(p.urns, p.refs).join('\n'),
            }

        case 'path': {
            const end = (urns?: string[] | null, refs?: NodeRef[] | null, where?: Predicate | null) =>
                where ? describePredicate(where).label : (named(urns, refs)[0] ?? '∅')
            return {
                icon: 'GitFork',
                label: `paths ${end(p.sourceUrns, p.sourceRefs, p.sourceWhere)} → ${end(p.targetUrns, p.targetRefs, p.targetWhere)} (≤${p.maxHops}h)`,
                title: `${named(p.sourceUrns, p.sourceRefs).join(', ')}\n→\n${named(p.targetUrns, p.targetRefs).join(', ')}`,
            }
        }

        case 'is': {
            const names = named([], p.refs)
            return {
                icon: 'Crosshair',
                label: `is ${names[0] ?? '∅'}${names.length > 1 ? ` +${names.length - 1}` : ''}`,
                title: names.join('\n'),
            }
        }

        case 'related': {
            const meta = axisMeta(p.axis)
            const [lo, hi] = hopRange(p)
            const hops = meta.lineage && hi > 1 ? ` ${lo === hi ? hi : `${lo}–${hi}`}h` : ''
            const count = p.count ? `${DEGREE_OP_LABEL[p.count.op ?? 'gte']}${p.count.value} ` : ''
            const lead = p.quantifier === 'none' ? 'no '
                : p.quantifier === 'all' ? 'every ' : count
            const noun = count && p.count?.value !== 1 ? meta.plural : meta.noun
            const via = meta.lineage && throughOf(p) !== 'lineage' ? ` via ${edgeSetPhrase(p)}` : ''
            return {
                icon: meta.lineage ? 'Workflow' : 'Network',
                label: `${lead}${noun}${hops}${via}${p.where ? `: ${describePredicate(p.where).label}` : ''}`,
            }
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
    notContains: 'does not contain',
    containsAll: 'has all of',
    startsWith: 'starts with',
    endsWith: 'ends with',
    between: 'between',
    withinLast: 'within the last',
    isSet: 'is set',
    isNotSet: 'is not set',
    isEmpty: 'is empty',
    isNotEmpty: 'is not empty',
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

/** The entities an end names: its URNs' labels, then its names. */
function named(urns?: string[] | null, refs?: NodeRef[] | null): string[] {
    return [...(urns ?? []).map((u) => formatUrnLabel(u)), ...(refs ?? []).map(refLabel)]
}

function valueLabel(v: unknown): string {
    if (v === null || v === undefined) return '∅'
    if (Array.isArray(v)) return `[${v.map(valueLabel).join(', ')}]`
    if (typeof v === 'string') return v.length > 24 ? `"${v.slice(0, 24)}…"` : `"${v}"`
    return String(v)
}
