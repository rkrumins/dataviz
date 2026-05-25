/**
 * NestedGroupCard — recursive card that renders a GroupPredicate
 * inline inside the QueryCard's flat list of conditions.
 *
 * Visual language matches ConditionRow so a leaf and a group look like
 * variants of the same UI element. The group header carries an
 * AND / OR / NOT pill, a subtle left accent that hints at depth, and a
 * delete button. Children are rendered as REAL ConditionRow editors
 * (so a TextPredicate inside a group is fully editable in place), and
 * nested groups recurse back into NestedGroupCard.
 *
 * Footer affordances let the user grow the tree from inside Visual mode
 * alone — "+ Condition" opens a leaf picker, "+ AND group" /
 * "+ OR group" insert empty sub-groups.
 *
 * Depth cap: nesting beyond 3 levels collapses to a placeholder with
 * an "Open Advanced" handoff to the dedicated builder drawer.
 */
import { motion, AnimatePresence } from 'framer-motion'
import {
    ChevronDown,
    Plus,
    Search,
    Sparkles,
    X,
} from 'lucide-react'
import * as LucideIcons from 'lucide-react'
import { type FC, useEffect, useMemo, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import type { GroupPredicate, Predicate } from '@/types/search'

import { ConditionRow } from './ConditionRow'
import type { LayerOption } from './layerOptions'
import { LEAF_KINDS, type LeafKindMeta } from '../builder/leafKinds'


type GroupOp = NonNullable<GroupPredicate['op']>


const NESTED_GROUP_DEPTH_CAP = 3


interface OpStyle {
    label: string
    sub: string
    /** Tailwind tone applied to the op pill + accent stripe. */
    tone: string
    /** Background tint for the card. */
    bg: string
    /** Accent border color (left stripe). */
    accent: string
}


const OP_STYLES: Record<GroupOp, OpStyle> = {
    and: {
        label: 'ALL',
        sub: 'and',
        tone: 'text-accent-lineage',
        bg: 'from-accent-lineage/[0.06] to-accent-lineage/[0.02]',
        accent: 'before:bg-accent-lineage/40',
    },
    or: {
        label: 'ANY',
        sub: 'or',
        tone: 'text-amber-300',
        bg: 'from-amber-500/[0.06] to-amber-500/[0.02]',
        accent: 'before:bg-amber-500/40',
    },
    not: {
        label: 'NOT',
        sub: 'invert',
        tone: 'text-rose-300',
        bg: 'from-rose-500/[0.06] to-rose-500/[0.02]',
        accent: 'before:bg-rose-500/40',
    },
}


export interface NestedGroupCardProps {
    group: GroupPredicate
    depth?: number
    /** Replace this group's tree with ``next`` (or null to delete). */
    onChange: (next: GroupPredicate | null) => void
    /** Delete the whole group from the parent. */
    onRemove: () => void
    onOpenAdvanced: () => void
    onSubmit?: () => void
    disabled?: boolean
    // ConditionRow context (passed straight through to leaf children).
    discovery: {
        allKeys: string[]
        keysByEntityType: Record<string, string[]>
        tagValues: string[]
        getValueSamples: (key: string) => unknown[]
    }
    knownEntityTypes: string[]
    activeEntityTypes: string[]
    discoveredLayers: LayerOption[]
}


export const NestedGroupCard: FC<NestedGroupCardProps> = ({
    group, depth = 0,
    onChange, onRemove, onOpenAdvanced, onSubmit, disabled,
    discovery, knownEntityTypes, activeEntityTypes, discoveredLayers,
}) => {
    const op: GroupOp = group.op ?? 'and'
    const styles = OP_STYLES[op]
    const [pickerOpen, setPickerOpen] = useState(false)

    if (depth >= NESTED_GROUP_DEPTH_CAP) {
        return (
            <div className={cn(
                'rounded-xl border border-dashed border-glass-border/60',
                'bg-canvas-base/30 px-3.5 py-3',
                'flex items-center justify-between gap-2',
            )}>
                <span className="text-[11.5px] text-ink-muted">
                    Deeply nested group — keep editing in Advanced
                </span>
                <button
                    type="button"
                    onClick={onOpenAdvanced}
                    className="text-[11px] text-accent-lineage hover:text-accent-lineage/80 transition-colors"
                >
                    Open Advanced →
                </button>
            </div>
        )
    }

    function setOp(next: GroupOp) {
        if (disabled || next === op) return
        if (next === 'not') {
            // NOT requires exactly one child. Collapse multi-child to AND
            // before wrapping, so users don't lose state.
            if (group.children.length <= 1) {
                onChange({ kind: 'group', op: 'not', children: group.children })
            } else {
                const inner: GroupPredicate = {
                    kind: 'group', op: 'and', children: group.children,
                }
                onChange({ kind: 'group', op: 'not', children: [inner] })
            }
            return
        }
        // Switching out of NOT with a single nested AND child: unwrap.
        if (op === 'not'
            && group.children.length === 1
            && group.children[0].kind === 'group'
        ) {
            const child = group.children[0] as GroupPredicate
            onChange({ kind: 'group', op: next, children: [...child.children] })
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

    function appendChild(child: Predicate) {
        // NOT may only hold one child — silently swap a new add.
        if (op === 'not' && group.children.length >= 1) {
            onChange({ ...group, children: [child] })
            return
        }
        onChange({ ...group, children: [...group.children, child] })
    }

    const canAddLeaf = op !== 'not' || group.children.length === 0

    return (
        <div className={cn(
            'relative rounded-xl border border-glass-border/70',
            'bg-gradient-to-br backdrop-blur-sm',
            styles.bg,
            // Left accent stripe — pseudo-element so it can be tone-coloured
            'before:absolute before:left-0 before:top-3 before:bottom-3',
            'before:w-[3px] before:rounded-full',
            styles.accent,
            'pl-4 pr-3 py-3 flex flex-col gap-2.5',
        )}>
            {/* Header */}
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <OperatorPill op={op} onChange={setOp} disabled={disabled} />
                    <span className="text-[10.5px] text-ink-muted/80 leading-none">
                        {op === 'not'
                            ? 'invert the result of the inner condition'
                            : op === 'and'
                                ? 'all conditions below must match'
                                : 'any condition below matches'}
                    </span>
                </div>
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

            {/* Children */}
            {group.children.length === 0 ? (
                <EmptyGroupState op={op} onPick={() => setPickerOpen(true)} />
            ) : (
                <AnimatePresence initial={false}>
                    <div className="flex flex-col gap-1.5">
                        {group.children.map((child, i) => (
                            <motion.div
                                key={`${child.kind}-${i}`}
                                initial={{ opacity: 0, y: -4 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -4 }}
                                transition={{ duration: 0.12 }}
                            >
                                {i > 0 && <ChildJoiner op={op} />}
                                {child.kind === 'group' ? (
                                    <NestedGroupCard
                                        group={child as GroupPredicate}
                                        depth={depth + 1}
                                        onChange={(next) => replaceChild(i, next)}
                                        onRemove={() => replaceChild(i, null)}
                                        onOpenAdvanced={onOpenAdvanced}
                                        onSubmit={onSubmit}
                                        disabled={disabled}
                                        discovery={discovery}
                                        knownEntityTypes={knownEntityTypes}
                                        activeEntityTypes={activeEntityTypes}
                                        discoveredLayers={discoveredLayers}
                                    />
                                ) : (
                                    <ConditionRow
                                        value={child}
                                        discovery={discovery}
                                        knownEntityTypes={knownEntityTypes}
                                        activeEntityTypes={activeEntityTypes}
                                        discoveredLayers={discoveredLayers}
                                        isRunning={disabled ?? false}
                                        onChange={(next) => replaceChild(i, next)}
                                        onRemove={() => replaceChild(i, null)}
                                        onOpenAdvanced={onOpenAdvanced}
                                        onSubmit={onSubmit}
                                    />
                                )}
                            </motion.div>
                        ))}
                    </div>
                </AnimatePresence>
            )}

            {/* Footer affordances */}
            <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                {canAddLeaf && (
                    <InlineAddCondition
                        open={pickerOpen}
                        onOpenChange={setPickerOpen}
                        onPick={(p) => {
                            appendChild(p)
                            setPickerOpen(false)
                        }}
                        disabled={disabled}
                    />
                )}
                {op !== 'not' && depth < NESTED_GROUP_DEPTH_CAP - 1 && (
                    <>
                        <MiniGroupAddButton
                            op="and"
                            onClick={() => appendChild({
                                kind: 'group', op: 'and', children: [],
                            })}
                            disabled={disabled}
                        />
                        <MiniGroupAddButton
                            op="or"
                            onClick={() => appendChild({
                                kind: 'group', op: 'or', children: [],
                            })}
                            disabled={disabled}
                        />
                    </>
                )}
            </div>
        </div>
    )
}


// ---------------------------------------------------------------------------
// Header pill — three-segment AND / OR / NOT toggle
// ---------------------------------------------------------------------------

function OperatorPill({
    op, onChange, disabled,
}: {
    op: GroupOp
    onChange: (next: GroupOp) => void
    disabled?: boolean
}) {
    return (
        <div className={cn(
            'inline-flex rounded-full p-0.5',
            'border border-glass-border/70 bg-canvas-elevated/50',
            'backdrop-blur-sm',
        )}>
            {(['and', 'or', 'not'] as GroupOp[]).map((candidate) => {
                const meta = OP_STYLES[candidate]
                const active = op === candidate
                return (
                    <button
                        key={candidate}
                        type="button"
                        onClick={() => onChange(candidate)}
                        disabled={disabled}
                        className={cn(
                            'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full',
                            'text-[10.5px] font-semibold uppercase tracking-wider',
                            'transition-colors',
                            active
                                ? `${meta.tone} bg-canvas-base/50 shadow-sm`
                                : 'text-ink-muted/70 hover:text-ink',
                            disabled && 'opacity-50 cursor-not-allowed',
                        )}
                        title={
                            candidate === 'and' ? 'ALL — match every child' :
                                candidate === 'or' ? 'ANY — match at least one' :
                                    'NOT — invert the result'
                        }
                    >
                        {meta.label}
                        <span className="text-[8.5px] opacity-50 uppercase">
                            {meta.sub}
                        </span>
                    </button>
                )
            })}
        </div>
    )
}


function ChildJoiner({ op }: { op: GroupOp }) {
    if (op === 'not') return null
    const tone = op === 'and' ? 'text-accent-lineage/75' : 'text-amber-300/85'
    return (
        <div className="flex items-center justify-center -my-0.5">
            <span className={cn(
                'inline-flex items-center px-2 py-0 rounded-full',
                'text-[9px] font-semibold uppercase tracking-[0.18em]',
                'bg-canvas-base/40 border border-glass-border/40',
                tone,
            )}>
                {op === 'and' ? 'AND' : 'OR'}
            </span>
        </div>
    )
}


function EmptyGroupState({
    op, onPick,
}: { op: GroupOp; onPick: () => void }) {
    return (
        <button
            type="button"
            onClick={onPick}
            className={cn(
                'group/empty w-full rounded-lg border border-dashed border-glass-border/60',
                'bg-canvas-elevated/20 hover:bg-canvas-elevated/40',
                'px-3.5 py-3.5 flex items-center justify-center gap-2',
                'text-[11.5px] text-ink-muted/80 hover:text-accent-lineage',
                'transition-colors',
            )}
        >
            <Sparkles className="w-3.5 h-3.5 opacity-70 group-hover/empty:opacity-100" strokeWidth={2} />
            {op === 'not'
                ? 'Empty NOT group — pick one condition to invert'
                : 'Empty group — pick a condition to start'}
        </button>
    )
}


// ---------------------------------------------------------------------------
// Footer: + Condition (with picker) and + AND/OR group
// ---------------------------------------------------------------------------

function MiniGroupAddButton({
    op, onClick, disabled,
}: {
    op: 'and' | 'or'
    onClick: () => void
    disabled?: boolean
}) {
    const meta = OP_STYLES[op]
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
                'inline-flex items-center gap-1 px-2 py-1 rounded-md',
                'text-[10.5px] font-medium',
                'border border-glass-border/50 bg-canvas-elevated/30',
                'hover:bg-canvas-elevated/60 hover:border-glass-border transition-colors',
                meta.tone,
                disabled && 'opacity-50 cursor-not-allowed',
            )}
            title={`Insert an empty ${op.toUpperCase()} group inside this group`}
        >
            <Plus className="w-3 h-3" strokeWidth={2.5} />
            {meta.label} group
        </button>
    )
}


/**
 * Compact dropdown leaf picker — opens beneath the "+ Condition" button.
 * Mirrors the AddFilterPalette but is mounted inside a group so the
 * user can keep building without leaving the nested card.
 */
function InlineAddCondition({
    open, onOpenChange, onPick, disabled,
}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    onPick: (predicate: Predicate) => void
    disabled?: boolean
}) {
    const containerRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (!open) return
        const handler = (e: MouseEvent) => {
            if (!containerRef.current?.contains(e.target as Node)) {
                onOpenChange(false)
            }
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [open, onOpenChange])

    return (
        <div ref={containerRef} className="relative">
            <button
                type="button"
                onClick={() => onOpenChange(!open)}
                disabled={disabled}
                className={cn(
                    'inline-flex items-center gap-1 px-2.5 py-1 rounded-md',
                    'text-[10.5px] font-medium',
                    'border border-accent-lineage/40 bg-accent-lineage/10',
                    'text-accent-lineage',
                    'hover:bg-accent-lineage/15 transition-colors',
                    disabled && 'opacity-50 cursor-not-allowed',
                )}
            >
                <Plus className="w-3 h-3" strokeWidth={2.5} />
                Condition
                <ChevronDown
                    className={cn('w-3 h-3 opacity-70 transition-transform', open && 'rotate-180')}
                    strokeWidth={2}
                />
            </button>
            {open && (
                <LeafPickerDropdown
                    onPick={(meta) => onPick(meta.makeEmpty())}
                    onDismiss={() => onOpenChange(false)}
                />
            )}
        </div>
    )
}


function iconFor(name: string): FC<{ className?: string; strokeWidth?: number }> {
    const Component = (LucideIcons as unknown as Record<
        string, FC<{ className?: string; strokeWidth?: number }>
    >)[name]
    return Component ?? LucideIcons.Sparkles
}


const CATEGORY_LABELS: Record<LeafKindMeta['category'], string> = {
    property: 'Tags & properties',
    identity: 'Structure',
    graph: 'Lineage',
    scope: 'Scope',
    text: 'Text',
}


function LeafPickerDropdown({
    onPick, onDismiss,
}: {
    onPick: (meta: LeafKindMeta) => void
    onDismiss: () => void
}) {
    const [query, setQuery] = useState('')
    const [highlight, setHighlight] = useState(0)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => { inputRef.current?.focus() }, [])

    const filtered = useMemo<LeafKindMeta[]>(() => {
        const q = query.trim().toLowerCase()
        if (!q) return [...LEAF_KINDS]
        return LEAF_KINDS.filter((m) =>
            m.label.toLowerCase().includes(q) ||
            m.description.toLowerCase().includes(q) ||
            m.kind.toLowerCase().includes(q),
        )
    }, [query])

    function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHighlight((i) => Math.min(filtered.length - 1, i + 1))
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHighlight((i) => Math.max(0, i - 1))
        } else if (e.key === 'Enter') {
            e.preventDefault()
            const pick = filtered[highlight]
            if (pick) onPick(pick)
        } else if (e.key === 'Escape') {
            e.preventDefault()
            onDismiss()
        }
    }

    return (
        <div className={cn(
            'absolute left-0 top-full mt-1.5 z-40 w-[22rem]',
            'rounded-2xl border border-glass-border bg-canvas-elevated/95',
            'backdrop-blur-xl shadow-2xl shadow-black/50 ring-1 ring-white/5',
            'flex flex-col overflow-hidden',
        )}>
            <div className={cn(
                'flex items-center gap-2 px-3 py-2.5 border-b border-glass-border/50',
                'bg-canvas-base/40',
            )}>
                <Search className="w-3.5 h-3.5 text-ink-muted shrink-0" strokeWidth={2} />
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => {
                        setQuery(e.target.value)
                        setHighlight(0)
                    }}
                    onKeyDown={handleKey}
                    placeholder="Filter conditions…"
                    className={cn(
                        'flex-1 min-w-0 bg-transparent outline-none border-none p-0',
                        'text-[12.5px] text-ink placeholder:text-ink-muted/55',
                    )}
                />
            </div>
            <div className="max-h-[20rem] overflow-y-auto custom-scrollbar py-1">
                {filtered.length === 0 ? (
                    <div className="px-4 py-6 text-center text-[11px] text-ink-muted leading-snug">
                        No condition matches <span className="font-mono text-ink">{query}</span>.
                    </div>
                ) : (
                    filtered.map((m, i) => {
                        const Icon = iconFor(m.icon)
                        return (
                            <button
                                key={m.kind}
                                type="button"
                                onClick={() => onPick(m)}
                                onMouseEnter={() => setHighlight(i)}
                                className={cn(
                                    'w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors',
                                    i === highlight
                                        ? 'bg-accent-lineage/12'
                                        : 'hover:bg-glass/30',
                                )}
                            >
                                <span className={cn(
                                    'shrink-0 mt-0.5 rounded-lg p-1.5',
                                    'bg-accent-lineage/10 text-accent-lineage',
                                )}>
                                    <Icon className="w-3.5 h-3.5" strokeWidth={2} />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-1.5">
                                        <span className="text-[12.5px] font-medium text-ink leading-tight">
                                            {m.label}
                                        </span>
                                        <span className={cn(
                                            'text-[9px] uppercase tracking-wider',
                                            'text-ink-muted/60 px-1 py-0.5 rounded bg-glass/30',
                                        )}>
                                            {CATEGORY_LABELS[m.category]}
                                        </span>
                                    </span>
                                    <span className="block mt-0.5 text-[10.5px] text-ink-muted leading-snug">
                                        {m.description}
                                    </span>
                                </span>
                            </button>
                        )
                    })
                )}
            </div>
        </div>
    )
}
