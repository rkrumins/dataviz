/**
 * DisplayRuleList — the roster of saved display rules inside the
 * Property Manager. Each card shows the tag chip, the rule's count in the
 * view (from ``displayRuleMatchStore``), and enable / reveal / edit /
 * delete / reorder controls.
 *
 * Reorder is exposed as up/down affordances (keyboard-friendly, no DnD
 * dependency) — chip stacking order on the canvas follows rule order.
 *
 * Someone who can't edit the view sees its rules and their counts, and can
 * reveal their matches, but not change them.
 */
import { motion } from 'framer-motion'
import {
    ArrowDown, ArrowUp, Crosshair, Pencil, Plus, Tags, Trash2,
} from 'lucide-react'

import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { cn } from '@/lib/utils'
import type { DisplayRuleConfig } from '@/types/schema'
import { useRuleCount } from '@/store/displayRuleMatchStore'


export interface DisplayRuleListProps {
    rules: DisplayRuleConfig[]
    onNew: () => void
    onEdit: (rule: DisplayRuleConfig) => void
    onToggle: (id: string) => void
    onDelete: (id: string) => void
    /** Reorder to a new id sequence (chip stacking order). */
    onReorder: (orderedIds: string[]) => void
    /** Show every match of a rule (runs its criteria as a search). */
    onReveal: (rule: DisplayRuleConfig) => void
    /** The caller can't change the view's rules: show them, don't offer edits. */
    readOnly?: boolean
}


export function DisplayRuleList({
    rules, onNew, onEdit, onToggle, onDelete, onReorder, onReveal, readOnly = false,
}: DisplayRuleListProps) {
    const move = (index: number, dir: -1 | 1) => {
        const next = [...rules]
        const target = index + dir
        if (target < 0 || target >= next.length) return
        ;[next[index], next[target]] = [next[target], next[index]]
        onReorder(next.map((r) => r.id))
    }

    if (rules.length === 0 && readOnly) {
        return (
            <div className="rounded-2xl p-5 text-center border border-glass-border bg-black/[0.02] dark:bg-white/[0.03]">
                <div className="mx-auto w-11 h-11 rounded-2xl bg-black/[0.04] dark:bg-white/[0.06] flex items-center justify-center mb-3">
                    <Tags className="w-5 h-5 text-ink-muted" strokeWidth={1.8} />
                </div>
                <div className="text-sm font-display font-semibold text-ink">No display rules yet</div>
                <p className="mt-1.5 text-xs text-ink-muted leading-snug max-w-[34ch] mx-auto">
                    People who can edit this view can add rules that tag matching entities.
                </p>
            </div>
        )
    }

    if (rules.length === 0) {
        return (
            <div className="flex flex-col gap-4">
                {/* Empty-state hero — premium, value-prop forward. */}
                <div className={cn(
                    'rounded-2xl p-5 text-center',
                    'bg-gradient-to-br from-accent-lineage/[0.10] via-canvas-elevated/40 to-purple-500/[0.05]',
                    'border border-accent-lineage/25',
                )}>
                    <div className="mx-auto w-11 h-11 rounded-2xl bg-accent-lineage/15 flex items-center justify-center mb-3">
                        <Tags className="w-5 h-5 text-accent-lineage" strokeWidth={1.8} />
                    </div>
                    <div className="text-base font-display font-semibold text-ink leading-tight">
                        Tag entities by criteria
                    </div>
                    <p className="mt-1.5 text-xs text-ink-muted leading-snug max-w-[34ch] mx-auto">
                        Create a display rule to decorate matching entities with a colored
                        tag on the canvas — e.g. everything classified PII, or every dataset
                        missing an owner.
                    </p>
                    <button
                        type="button"
                        onClick={onNew}
                        className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-accent-lineage text-white hover:bg-accent-lineage/90 shadow-sm shadow-accent-lineage/30 transition-all"
                    >
                        <Plus className="w-3.5 h-3.5" strokeWidth={2.5} /> Create your first rule
                    </button>
                </div>
                <p className="text-[11px] text-ink-muted/80 leading-snug text-center">
                    Tip: the <span className="text-ink font-medium">Properties</span> tab lets
                    you browse what’s in use and turn any property or tag into a rule in one click.
                </p>
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-3">
            {readOnly ? (
                <p className="text-[11px] text-ink-muted leading-snug">
                    Rules tag matched entities on the canvas. Only people who can edit this
                    view can change them.
                </p>
            ) : (
            <div className="flex items-center justify-between">
                <p className="text-[11px] text-ink-muted leading-snug max-w-[70%]">
                    Rules tag matched entities on the canvas. Drag order sets chip stacking.
                </p>
                <button
                    type="button"
                    onClick={onNew}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-accent-lineage text-white hover:bg-accent-lineage/90 shadow-sm shadow-accent-lineage/30 transition-all shrink-0"
                >
                    <Plus className="w-3.5 h-3.5" strokeWidth={2.5} /> New rule
                </button>
            </div>
            )}

            <div className="flex flex-col gap-2">
                {rules.map((rule, index) => (
                    <RuleCard
                        key={rule.id}
                        rule={rule}
                        isFirst={index === 0}
                        isLast={index === rules.length - 1}
                        readOnly={readOnly}
                        onEdit={() => onEdit(rule)}
                        onToggle={() => onToggle(rule.id)}
                        onDelete={() => onDelete(rule.id)}
                        onReveal={() => onReveal(rule)}
                        onMoveUp={() => move(index, -1)}
                        onMoveDown={() => move(index, 1)}
                    />
                ))}
            </div>
        </div>
    )
}


/** A rule's total in the view: exact once counted, what has been found so
 *  far while the count runs, or why it couldn't be counted (or finished). */
function RuleCountLine({ enabled, count }: {
    enabled: boolean
    count: ReturnType<typeof useRuleCount>
}) {
    if (!enabled) return <>Disabled</>
    if (!count) return <>Counting…</>
    if (count.error && count.complete) {
        return <span className="text-rose-400" title={count.error}>Can't be counted</span>
    }
    const n = <span className="text-ink font-semibold">{count.count.toLocaleString()}</span>
    if (count.error) {
        return <span title={count.error}>At least {n} · <span className="text-rose-400">count stopped</span></span>
    }
    if (!count.complete) return <>{n} so far · counting {count.percent}%</>
    return <>{n} {count.count === 1 ? 'match' : 'matches'} in this view</>
}


function RuleCard({
    rule, isFirst, isLast, readOnly, onEdit, onToggle, onDelete, onReveal, onMoveUp, onMoveDown,
}: {
    rule: DisplayRuleConfig
    isFirst: boolean
    isLast: boolean
    readOnly: boolean
    onEdit: () => void
    onToggle: () => void
    onDelete: () => void
    onReveal: () => void
    onMoveUp: () => void
    onMoveDown: () => void
}) {
    const count = useRuleCount(rule.id)
    // Reveal runs the rule as a search, so it only waits on a count that
    // has finished and found nothing.
    const nothingToReveal = !rule.enabled || (count?.complete === true && count.count === 0)

    return (
        <motion.div
            layout
            className={cn(
                'group rounded-xl border bg-canvas-elevated/30 px-3 py-2.5 transition-all',
                rule.enabled ? 'border-glass-border/70' : 'border-glass-border/40 opacity-60',
            )}
        >
            <div className="flex items-center gap-2.5">
                {/* Reorder handles */}
                {!readOnly && (
                <div className="flex flex-col -my-1 shrink-0">
                    <button
                        type="button"
                        onClick={onMoveUp}
                        disabled={isFirst}
                        title="Move up"
                        className={cn('p-0.5 rounded text-ink-muted/60 transition-colors',
                            isFirst ? 'opacity-25 cursor-not-allowed' : 'hover:text-ink hover:bg-glass/40')}
                    >
                        <ArrowUp className="w-3 h-3" />
                    </button>
                    <button
                        type="button"
                        onClick={onMoveDown}
                        disabled={isLast}
                        title="Move down"
                        className={cn('p-0.5 rounded text-ink-muted/60 transition-colors',
                            isLast ? 'opacity-25 cursor-not-allowed' : 'hover:text-ink hover:bg-glass/40')}
                    >
                        <ArrowDown className="w-3 h-3" />
                    </button>
                </div>
                )}

                {/* Enable toggle */}
                <button
                    type="button"
                    onClick={onToggle}
                    role="switch"
                    aria-checked={rule.enabled}
                    disabled={readOnly}
                    title={readOnly ? (rule.enabled ? 'On' : 'Off')
                        : rule.enabled ? 'Disable rule' : 'Enable rule'}
                    className={cn(
                        'relative w-9 h-5 rounded-full transition-colors shrink-0',
                        rule.enabled ? 'bg-accent-lineage/80' : 'bg-glass/60',
                        readOnly && 'cursor-default opacity-70',
                    )}
                >
                    <span className={cn(
                        'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all',
                        rule.enabled ? 'left-[18px]' : 'left-0.5',
                    )} />
                </button>

                {/* Tag chip + match count */}
                <div className="min-w-0 flex-1">
                    <span
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium max-w-full align-middle"
                        style={{ backgroundColor: `${rule.color}26`, color: rule.color }}
                        title={rule.name}
                    >
                        {rule.icon && <DynamicIcon name={rule.icon} className="w-3 h-3 shrink-0" />}
                        <span className="truncate">{rule.name}</span>
                    </span>
                    <div className="mt-1 text-[10.5px] text-ink-muted tabular-nums" aria-live="polite">
                        <RuleCountLine enabled={rule.enabled} count={count} />
                    </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                    <button
                        type="button"
                        onClick={onReveal}
                        title="Show every match in search"
                        disabled={nothingToReveal}
                        className={cn('p-1.5 rounded-lg transition-colors',
                            nothingToReveal
                                ? 'text-ink-muted/30 cursor-not-allowed'
                                : 'text-ink-muted hover:text-accent-lineage hover:bg-accent-lineage/10')}
                    >
                        <Crosshair className="w-3.5 h-3.5" />
                    </button>
                    {!readOnly && (<>
                    <button
                        type="button"
                        onClick={onEdit}
                        title="Edit rule"
                        className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-glass/40 transition-colors"
                    >
                        <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                        type="button"
                        onClick={onDelete}
                        title="Delete rule"
                        className="p-1.5 rounded-lg text-ink-muted hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                    </>)}
                </div>
            </div>
        </motion.div>
    )
}
