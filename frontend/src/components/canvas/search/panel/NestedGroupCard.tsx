/**
 * NestedGroupCard — recursive card that renders a GroupPredicate
 * inline inside the QueryCard's flat list of conditions.
 *
 * Uses the shared builder-atoms — same RowCard, same OperatorPill,
 * same RowJoiner, same portalled AddRowButton + RowMenu — so leaves
 * and groups read as variants of one card design. The card tone
 * (purple AND, amber OR, rose NOT) encodes the operator at a glance;
 * leaves use the neutral tone.
 *
 * Children rendered as REAL ConditionRow editors when they are
 * leaves (so a TextPredicate inside a group is fully editable in
 * place) and recurse into NestedGroupCard when they are groups.
 *
 * Depth cap at 3 levels — beyond that the card collapses to an
 * "Open Advanced" hand-off so the panel stays readable.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { Sparkles, X } from 'lucide-react'
import { type FC } from 'react'

import { cn } from '@/lib/utils'
import { useSearchStore } from '@/store/searchStore'
import type { GroupPredicate, Predicate } from '@/types/search'

import { AddRowButton } from './builder-atoms/AddRowButton'
import { OperatorPill } from './builder-atoms/OperatorPill'
import { RowCard } from './builder-atoms/RowCard'
import { RowJoiner } from './builder-atoms/RowJoiner'
import { RowMenu } from './builder-atoms/RowMenu'
import { RowSelectionCheckbox } from './builder-atoms/RowSelectionCheckbox'
import { NESTED_TONE_BG, OP_HINTS, TONE_STYLES, type OpTone } from './builder-atoms/tones'
import { ConditionRow } from './ConditionRow'
import type { LayerOption } from './layerOptions'


/** Compose a dot-path: '' + 0 → '0'; '0' + 1 → '0.1'. */
function joinPath(parentPath: string, index: number): string {
    return parentPath === '' ? String(index) : `${parentPath}.${index}`
}


type GroupOp = NonNullable<GroupPredicate['op']>


const NESTED_GROUP_DEPTH_CAP = 3


export interface NestedGroupCardProps {
    group: GroupPredicate
    depth?: number
    /** Replace this group's tree with ``next`` (or null to delete). */
    onChange: (next: GroupPredicate | null) => void
    /** Delete the whole group from the parent. */
    onRemove: () => void
    /** Wrap this entire group in another group of the chosen op. */
    onWrap?: (op: OpTone) => void
    /** Duplicate this whole group in the parent. */
    onDuplicate?: () => void
    onOpenAdvanced: () => void
    onSubmit?: () => void
    disabled?: boolean
    discovery: {
        allKeys: string[]
        keysByEntityType: Record<string, string[]>
        tagValues: string[]
        getValueSamples: (key: string) => unknown[]
    }
    knownEntityTypes: string[]
    activeEntityTypes: string[]
    discoveredLayers: LayerOption[]
    /** Multi-select context for this group itself. ``parentPath`` is
     *  the dot-path of THIS group's parent (so we can render a
     *  selection checkbox on the group header). When the group
     *  renders its own children, the children's parentPath is this
     *  group's full path. */
    parentPath?: string
    index?: number
}


export const NestedGroupCard: FC<NestedGroupCardProps> = ({
    group, depth = 0,
    onChange, onRemove, onWrap, onDuplicate, onOpenAdvanced, onSubmit, disabled,
    discovery, knownEntityTypes, activeEntityTypes, discoveredLayers,
    parentPath, index,
}) => {
    const op: GroupOp = (group.op ?? 'and') as GroupOp

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

    function setOp(next: OpTone) {
        if (disabled || next === op) return
        if (next === 'not') {
            // NOT must have exactly one child — collapse multi-child to AND
            // before wrapping so the user doesn't lose state.
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

    function wrapChildAt(index: number, wrapOp: OpTone) {
        const target = group.children[index]
        if (!target) return
        const wrapped: GroupPredicate = {
            kind: 'group', op: wrapOp, children: [target],
        }
        replaceChild(index, wrapped)
    }

    function duplicateChildAt(index: number) {
        const target = group.children[index]
        if (!target) return
        const next = [...group.children]
        next.splice(index + 1, 0, structuredClone(target) as Predicate)
        onChange({ ...group, children: next })
    }

    function appendChild(child: Predicate) {
        if (op === 'not' && group.children.length >= 1) {
            onChange({ ...group, children: [child] })
            return
        }
        onChange({ ...group, children: [...group.children, child] })
    }

    const canAddLeaf = op !== 'not' || group.children.length === 0

    // Depth-aware visual weight: at depth ≥ 1, attenuate the
    // background tint so nested groups read as "child of the row
    // above" rather than competing with the parent. The accent
    // stripe stays at full saturation so the role of the card is
    // still glanceable.
    const bgOverride = depth >= 1 ? NESTED_TONE_BG[op] : undefined
    // And use a smaller operator pill at depth ≥ 1 so the visual
    // weight reflects the hierarchy.
    const pillSize = depth >= 1 ? 'sm' : 'md'

    // Multi-select state — this group as a single row in its parent.
    const selectableAsRow = parentPath !== undefined && index !== undefined
    const selected = useSearchStore((s) =>
        selectableAsRow
        && s.selectionParent === parentPath
        && s.selectedIndices.includes(index!),
    )
    const toggleRowSelection = useSearchStore((s) => s.toggleRowSelection)
    // Path used as the parent for THIS group's children.
    const childParentPath = selectableAsRow
        ? joinPath(parentPath!, index!)
        : undefined

    return (
        <RowCard tone={op} bgOverride={bgOverride}>
            <div className="group/row flex flex-col gap-2.5">
                {/* Header */}
                <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                        {selectableAsRow && (
                            <RowSelectionCheckbox
                                selected={selected}
                                onToggle={() => toggleRowSelection(parentPath!, index!)}
                                ariaLabel={`Select ${op.toUpperCase()} group`}
                            />
                        )}
                        <OperatorPill
                            value={op}
                            onChange={setOp}
                            segments="three"
                            size={pillSize}
                            disabled={disabled}
                        />
                        <span className="text-[10.5px] text-ink-muted/80 leading-snug truncate">
                            {OP_HINTS[op]}
                        </span>
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                        {(onWrap || onDuplicate) && (
                            <RowMenu
                                onWrap={(w) => onWrap?.(w)}
                                onDuplicate={() => onDuplicate?.()}
                                onDelete={onRemove}
                                disabled={disabled}
                            />
                        )}
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
                </div>

                {/* Children */}
                {group.children.length === 0 ? (
                    <EmptyGroupState op={op} />
                ) : (
                    <AnimatePresence initial={false}>
                        <div className="flex flex-col gap-2">
                            {group.children.map((child, i) => (
                                <motion.div
                                    key={`${child.kind}-${i}`}
                                    initial={{ opacity: 0, y: -4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -4 }}
                                    transition={{ duration: 0.12 }}
                                >
                                    {i > 0 && op !== 'not' && (
                                        <RowJoiner op={op === 'and' ? 'and' : 'or'} />
                                    )}
                                    {child.kind === 'group' ? (
                                        <NestedGroupCard
                                            group={child as GroupPredicate}
                                            depth={depth + 1}
                                            onChange={(next) => replaceChild(i, next)}
                                            onRemove={() => replaceChild(i, null)}
                                            onWrap={(w) => wrapChildAt(i, w)}
                                            onDuplicate={() => duplicateChildAt(i)}
                                            onOpenAdvanced={onOpenAdvanced}
                                            onSubmit={onSubmit}
                                            disabled={disabled}
                                            discovery={discovery}
                                            knownEntityTypes={knownEntityTypes}
                                            activeEntityTypes={activeEntityTypes}
                                            discoveredLayers={discoveredLayers}
                                            parentPath={childParentPath}
                                            index={i}
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
                                            onWrap={(w) => wrapChildAt(i, w)}
                                            onDuplicate={() => duplicateChildAt(i)}
                                            onOpenAdvanced={onOpenAdvanced}
                                            onSubmit={onSubmit}
                                            parentPath={childParentPath}
                                            index={i}
                                        />
                                    )}
                                </motion.div>
                            ))}
                        </div>
                    </AnimatePresence>
                )}

                {/* Footer */}
                <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                    {canAddLeaf && (
                        <AddRowButton
                            onAdd={appendChild}
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
        </RowCard>
    )
}


function EmptyGroupState({ op }: { op: OpTone }) {
    return (
        <div className={cn(
            'w-full rounded-lg border border-dashed border-glass-border/60',
            'bg-canvas-elevated/20',
            'px-3.5 py-3.5 flex items-center justify-center gap-2',
            'text-[11.5px] text-ink-muted/80',
        )}>
            <Sparkles className="w-3.5 h-3.5 opacity-70" strokeWidth={2} />
            {op === 'not'
                ? 'Empty NOT group — pick one condition to invert'
                : 'Empty group — pick a condition to start'}
        </div>
    )
}


function MiniGroupAddButton({
    op, onClick, disabled,
}: {
    op: 'and' | 'or'
    onClick: () => void
    disabled?: boolean
}) {
    const meta = TONE_STYLES[op]
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
                meta.ink,
                disabled && 'opacity-50 cursor-not-allowed',
            )}
            title={`Insert an empty ${meta.label} group inside this group`}
        >
            <span className="text-[11px]">+</span>
            {meta.label} group
        </button>
    )
}
