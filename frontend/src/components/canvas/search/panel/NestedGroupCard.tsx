/**
 * NestedGroupCard — renders a GroupPredicate inline inside the
 * QueryCard's flat list of conditions.
 *
 * When the user types ``t2 AND (account OR opp)`` in Code mode, the
 * parser emits an AND group whose second child is an OR group. The
 * flat ConditionRow can't represent that — it knows only how to render
 * single-leaf predicates. This component fills the gap: a small
 * recursive renderer that shows the group's children + its op toggle.
 *
 * Scope: read + edit existing groups (the user came from Code paste or
 * a template). Adding new nested groups from the Visual UI is still
 * routed through the Advanced drawer (PredicateBuilder.tsx) so this
 * stays focused on the round-trip round case.
 *
 * Behaviour:
 *   - Children that are leaves render as a compact one-line summary
 *     with an inline op switch.
 *   - Children that are themselves groups recurse into another
 *     NestedGroupCard (capped at 3 levels of nesting; deeper trees
 *     show "open Advanced to edit").
 *   - The group's op (AND / OR / NOT) is a clickable header chip.
 *   - Each child has a × button to remove it.
 *   - When removing the last child of a group, the parent removes the
 *     group itself.
 */
import { ChevronDown, X } from 'lucide-react'
import type { FC } from 'react'

import { cn } from '@/lib/utils'
import type { GroupPredicate, Predicate } from '@/types/search'

import { stringifyPredicate } from './predicateDsl'


type GroupOp = NonNullable<GroupPredicate['op']>


const NESTED_GROUP_DEPTH_CAP = 3


const GROUP_OP_LABEL: Record<GroupOp, { label: string; sub: string }> = {
    and: { label: 'ALL', sub: 'and' },
    or:  { label: 'ANY', sub: 'or' },
    not: { label: 'NOT', sub: 'invert' },
}


export interface NestedGroupCardProps {
    group: GroupPredicate
    depth?: number
    /** Replace this group's tree with ``next`` (or null to delete). */
    onChange: (next: GroupPredicate | null) => void
    /** Delete the whole group from the parent. */
    onRemove: () => void
    onOpenAdvanced: () => void
    disabled?: boolean
}


export const NestedGroupCard: FC<NestedGroupCardProps> = ({
    group, depth = 0, onChange, onRemove, onOpenAdvanced, disabled,
}) => {
    const op = group.op ?? 'and'
    const opMeta = GROUP_OP_LABEL[op]

    if (depth >= NESTED_GROUP_DEPTH_CAP) {
        return (
            <div className={cn(
                'rounded-xl border border-dashed border-glass-border/60',
                'bg-canvas-base/30 px-3 py-2.5',
                'flex items-center justify-between gap-2',
            )}>
                <span className="text-[11.5px] text-ink-muted">
                    Deep nested group — open Advanced to edit
                </span>
                <button
                    type="button"
                    onClick={onOpenAdvanced}
                    className="text-[11px] text-accent-lineage hover:text-accent-lineage/80"
                >
                    Open Advanced →
                </button>
            </div>
        )
    }

    function cycleOp() {
        if (disabled) return
        const next: GroupOp = op === 'and' ? 'or' : op === 'or' ? 'not' : 'and'
        // NOT requires exactly 1 child; collapse to first child when switching to NOT.
        if (next === 'not') {
            if (group.children.length === 0) {
                onChange({ kind: 'group', op: 'not', children: [] })
                return
            }
            onChange({ kind: 'group', op: 'not', children: [group.children[0]] })
            return
        }
        onChange({ ...group, op: next })
    }

    function replaceChild(index: number, child: Predicate | null) {
        if (child === null) {
            const remaining = group.children.filter((_, j) => j !== index)
            if (remaining.length === 0) {
                onRemove()
                return
            }
            // NOT must have exactly one child; if a removal leaves >1 it
            // becomes an implicit AND of the remaining items (rare case).
            if (op === 'not' && remaining.length > 1) {
                onChange({ kind: 'group', op: 'and', children: remaining })
                return
            }
            onChange({ ...group, children: remaining })
            return
        }
        const next = [...group.children]
        next[index] = child
        onChange({ ...group, children: next })
    }

    return (
        <div className={cn(
            'rounded-xl border border-glass-border/70',
            'bg-gradient-to-b from-canvas-base/55 to-canvas-base/30',
            'px-3 py-2.5 flex flex-col gap-2',
        )}>
            <div className="flex items-center justify-between gap-2">
                <button
                    type="button"
                    onClick={cycleOp}
                    disabled={disabled}
                    className={cn(
                        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full',
                        'border border-glass-border/60 bg-canvas-elevated/40',
                        'text-[10.5px] font-semibold uppercase tracking-wider',
                        op === 'and' ? 'text-accent-lineage'
                            : op === 'or' ? 'text-amber-300'
                                : 'text-rose-300',
                        'hover:bg-canvas-elevated/70 transition-colors',
                        disabled && 'opacity-50 cursor-not-allowed',
                    )}
                    title={`Match ${opMeta.label.toLowerCase()} of (${opMeta.sub}) — click to cycle`}
                >
                    {opMeta.label}
                    <span className="text-[9px] uppercase tracking-wider opacity-60">
                        {opMeta.sub}
                    </span>
                </button>
                <button
                    type="button"
                    onClick={onRemove}
                    disabled={disabled}
                    title="Remove this group"
                    className={cn(
                        'inline-flex items-center justify-center w-6 h-6 rounded-md',
                        'text-ink-muted/70 hover:text-rose-400 hover:bg-rose-500/10',
                        'transition-colors',
                    )}
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>

            {group.children.length === 0 ? (
                <div className="rounded-md border border-dashed border-glass-border/50 px-2.5 py-2 text-[11px] text-ink-muted">
                    Empty group — open Advanced to add conditions.
                </div>
            ) : (
                <div className="flex flex-col gap-1.5">
                    {group.children.map((child, i) => (
                        <NestedChildRow
                            key={i}
                            value={child}
                            op={op}
                            isFirst={i === 0}
                            depth={depth}
                            disabled={disabled}
                            onChange={(next) => replaceChild(i, next)}
                            onOpenAdvanced={onOpenAdvanced}
                        />
                    ))}
                </div>
            )}

            <button
                type="button"
                onClick={onOpenAdvanced}
                className={cn(
                    'self-start text-[10.5px] text-ink-muted/80 hover:text-accent-lineage',
                    'transition-colors',
                )}
            >
                Open Advanced to add conditions inside this group →
            </button>
        </div>
    )
}


/**
 * One child inside a NestedGroupCard. Leaves render as a single-line
 * read-only summary (the user can still delete or open Advanced to
 * edit); groups recurse via NestedGroupCard.
 */
function NestedChildRow({
    value, op, isFirst, depth, disabled, onChange, onOpenAdvanced,
}: {
    value: Predicate
    op: GroupOp
    isFirst: boolean
    depth: number
    disabled?: boolean
    onChange: (next: Predicate | null) => void
    onOpenAdvanced: () => void
}) {
    if (value.kind === 'group') {
        return (
            <NestedGroupCard
                group={value as GroupPredicate}
                depth={depth + 1}
                onChange={onChange as (next: GroupPredicate | null) => void}
                onRemove={() => onChange(null)}
                onOpenAdvanced={onOpenAdvanced}
                disabled={disabled}
            />
        )
    }
    return (
        <div className="flex items-center gap-2">
            {!isFirst && (
                <span className={cn(
                    'inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold',
                    'uppercase tracking-wider',
                    op === 'and' ? 'text-accent-lineage/80' : 'text-amber-300/80',
                )}>
                    {op === 'and' ? 'AND' : op === 'or' ? 'OR' : ''}
                </span>
            )}
            <div className={cn(
                'flex-1 min-w-0 px-2.5 py-1.5 rounded-md',
                'border border-glass-border/50 bg-canvas-elevated/30',
                'text-[11.5px] text-ink font-mono truncate',
            )} title={stringifyPredicate(value)}>
                <ChevronDown className="inline-block w-2.5 h-2.5 mr-1 text-ink-muted/60" />
                {stringifyPredicate(value)}
            </div>
            <button
                type="button"
                onClick={() => onChange(null)}
                disabled={disabled}
                title="Remove this condition"
                className={cn(
                    'inline-flex items-center justify-center w-6 h-6 rounded-md',
                    'text-ink-muted/70 hover:text-rose-400 hover:bg-rose-500/10',
                    'transition-colors',
                )}
            >
                <X className="w-3 h-3" />
            </button>
        </div>
    )
}
