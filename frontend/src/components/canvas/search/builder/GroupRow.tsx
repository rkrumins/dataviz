/**
 * Recursive renderer for one Group node in the predicate tree.
 *
 * Renders:
 *   - A header with the AND/OR/NOT toggle and a delete button (root
 *     group cannot be deleted — only "Reset all").
 *   - Children, each rendered as either a PredicateRow (leaf) or a
 *     nested GroupRow (recursion).
 *   - A footer with "+ Add condition" (opens the leaf-kind picker)
 *     and "+ Add group" affordances.
 *
 * NOT groups (op='not') hide the "Add condition" button when they
 * already contain one child — they're constrained to exactly one.
 */
import { ChevronDown, MinusSquare, Plus, Search, Trash2 } from 'lucide-react'
import * as LucideIcons from 'lucide-react'
import { type FC, useEffect, useMemo, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import type { GroupPredicate, Predicate } from '@/types/search'

import { type EditorContext } from './editors'
import { MiniButton } from './editors/shared'
import { LEAF_KINDS, type LeafKind, type LeafKindMeta } from './leafKinds'
import { PredicateRow } from './PredicateRow'
import { type Path, type ValidationIssue } from './useBuilderReducer'


type GroupOp = NonNullable<GroupPredicate['op']>

const GROUP_OPS: { value: GroupOp; label: string; hint: string }[] = [
    { value: 'and', label: 'AND', hint: 'all conditions must match' },
    { value: 'or', label: 'OR',  hint: 'any condition matches' },
    { value: 'not', label: 'NOT', hint: 'invert (exactly one child)' },
]


function iconFor(name: string): FC<{ className?: string; strokeWidth?: number }> {
    const Component = (LucideIcons as unknown as Record<
        string, FC<{ className?: string; strokeWidth?: number }>
    >)[name]
    return Component ?? LucideIcons.Sparkles
}


export interface GroupRowProps {
    path: Path
    group: GroupPredicate
    ctx: EditorContext
    issues: ValidationIssue[]
    isRoot?: boolean
    onAddLeaf: (path: Path, leafKind: LeafKind) => void
    onAddGroup: (path: Path, op: GroupOp) => void
    onRemoveAt: (path: Path) => void
    onUpdateLeaf: (path: Path, next: Predicate) => void
    onToggleGroupOp: (path: Path, op: GroupOp) => void
}


export function GroupRow({
    path, group, ctx, issues, isRoot,
    onAddLeaf, onAddGroup, onRemoveAt, onUpdateLeaf, onToggleGroupOp,
}: GroupRowProps) {
    const op: GroupOp = group.op ?? 'and'
    const [pickerOpen, setPickerOpen] = useState(false)

    const ownIssues = issues.filter((i) => pathsEqual(i.path, path))
    const hasError = ownIssues.some((i) => i.severity === 'error')

    const canAddLeaf = op !== 'not' || group.children.length === 0

    return (
        <div className={cn(
            "rounded-2xl border bg-canvas-elevated/30 backdrop-blur-sm",
            hasError ? "border-red-500/50" : "border-glass-border/70",
            isRoot ? "p-3" : "p-3 ml-3",
            "flex flex-col gap-2.5",
        )}>
            {/* Header: op toggle + delete */}
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                    {GROUP_OPS.map((g) => (
                        <button
                            key={g.value}
                            type="button"
                            onClick={() => onToggleGroupOp(path, g.value)}
                            className={cn(
                                "px-2.5 py-1 rounded-md text-[11px] font-semibold tracking-wide transition-all",
                                op === g.value
                                    ? "bg-accent-lineage/20 text-accent-lineage ring-1 ring-accent-lineage/30"
                                    : "text-ink-muted hover:bg-glass/40 hover:text-ink",
                            )}
                            title={g.hint}
                        >
                            {g.label}
                        </button>
                    ))}
                    {!isRoot && group.children.length === 1 && (
                        <MiniButton
                            onClick={() => onRemoveAt(path)}
                            icon={MinusSquare}
                            variant="default"
                        >
                            unwrap
                        </MiniButton>
                    )}
                </div>
                {!isRoot && (
                    <MiniButton
                        onClick={() => onRemoveAt(path)}
                        icon={Trash2}
                        variant="danger"
                    />
                )}
            </div>

            {/* Inline error chips */}
            {ownIssues.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {ownIssues.map((issue, i) => (
                        <span
                            key={i}
                            className={cn(
                                "text-[10px] px-1.5 py-0.5 rounded",
                                issue.severity === 'error'
                                    ? "bg-red-500/15 text-red-400"
                                    : "bg-amber-500/15 text-amber-400",
                            )}
                        >
                            {issue.message}
                        </span>
                    ))}
                </div>
            )}

            {/* Children */}
            {group.children.length === 0 ? (
                <div className="rounded-lg border border-dashed border-glass-border/60 px-3 py-4 text-center text-[11px] text-ink-muted">
                    Empty group — add a condition or another group below.
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {group.children.map((child, i) => {
                        const childPath: Path = [...path, i]
                        if (child.kind === 'group') {
                            return (
                                <GroupRow
                                    key={i}
                                    path={childPath}
                                    group={child}
                                    ctx={ctx}
                                    issues={issues}
                                    onAddLeaf={onAddLeaf}
                                    onAddGroup={onAddGroup}
                                    onRemoveAt={onRemoveAt}
                                    onUpdateLeaf={onUpdateLeaf}
                                    onToggleGroupOp={onToggleGroupOp}
                                />
                            )
                        }
                        return (
                            <PredicateRow
                                key={i}
                                path={childPath}
                                value={child}
                                ctx={ctx}
                                issues={issues}
                                onUpdate={onUpdateLeaf}
                                onRemove={onRemoveAt}
                            />
                        )
                    })}
                </div>
            )}

            {/* Footer: add condition / add group */}
            <div className="flex items-center gap-2 flex-wrap">
                {canAddLeaf && (
                    <div className="relative">
                        <button
                            type="button"
                            onClick={() => setPickerOpen((v) => !v)}
                            className={cn(
                                "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg",
                                "bg-glass/30 hover:bg-glass/50",
                                "text-[11px] font-medium text-ink-muted hover:text-ink",
                                "transition-colors",
                            )}
                        >
                            <Plus className="w-3 h-3" strokeWidth={2.5} />
                            Add condition
                            <ChevronDown className="w-3 h-3 opacity-70" strokeWidth={2.5} />
                        </button>
                        {pickerOpen && (
                            <LeafPicker
                                onPick={(kind) => {
                                    setPickerOpen(false)
                                    onAddLeaf(path, kind)
                                }}
                                onDismiss={() => setPickerOpen(false)}
                            />
                        )}
                    </div>
                )}
                {op !== 'not' && (
                    <>
                        <MiniButton
                            onClick={() => onAddGroup(path, 'and')}
                            icon={Plus}
                        >
                            AND group
                        </MiniButton>
                        <MiniButton
                            onClick={() => onAddGroup(path, 'or')}
                            icon={Plus}
                        >
                            OR group
                        </MiniButton>
                    </>
                )}
            </div>
        </div>
    )
}


// ---------------------------------------------------------------------------
// Leaf-kind picker (pops below the "Add condition" button)
// ---------------------------------------------------------------------------

/**
 * Search-as-you-type leaf picker.
 *
 * Replaces the old category-popover with one filterable list. Common
 * "core" kinds (property / hasProperty / tag / entityType / layer /
 * text) surface first; "advanced graph-shape" kinds (degree, paths,
 * scope) sit behind a "More options" toggle so business users aren't
 * overwhelmed.
 */
function LeafPicker({
    onPick, onDismiss,
}: {
    onPick: (kind: LeafKind) => void
    onDismiss: () => void
}) {
    const [query, setQuery] = useState('')
    const [showAdvanced, setShowAdvanced] = useState(false)
    const [highlightIndex, setHighlightIndex] = useState(0)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        inputRef.current?.focus()
    }, [])

    // Categories considered "advanced" — hidden by default, surfaced
    // once the user expands or searches for something specific.
    const ADVANCED_CATEGORIES: Set<LeafKindMeta['category']> = useMemo(
        () => new Set(['graph', 'scope']),
        [],
    )

    const filtered = useMemo<LeafKindMeta[]>(() => {
        const q = query.trim().toLowerCase()
        const universe = q
            ? LEAF_KINDS
            : LEAF_KINDS.filter(
                (m) => showAdvanced || !ADVANCED_CATEGORIES.has(m.category),
            )
        if (!q) return [...universe]
        return universe.filter((m) =>
            m.label.toLowerCase().includes(q) ||
            m.kind.toLowerCase().includes(q) ||
            m.description.toLowerCase().includes(q),
        )
    }, [ADVANCED_CATEGORIES, query, showAdvanced])

    useEffect(() => {
        if (highlightIndex >= filtered.length) {
            setHighlightIndex(Math.max(0, filtered.length - 1))
        }
    }, [filtered.length, highlightIndex])

    const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHighlightIndex((i) => Math.min(filtered.length - 1, i + 1))
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHighlightIndex((i) => Math.max(0, i - 1))
        } else if (e.key === 'Enter') {
            e.preventDefault()
            const pick = filtered[highlightIndex]
            if (pick) onPick(pick.kind)
        } else if (e.key === 'Escape') {
            e.preventDefault()
            onDismiss()
        }
    }

    return (
        <>
            <Backdrop open onClick={onDismiss} zClassName="z-30" className="bg-transparent" />
            <div className={cn(
                "absolute z-40 mt-1.5 w-[22rem] left-0",
                "rounded-2xl border border-glass-border bg-canvas-elevated/95 backdrop-blur-xl",
                "shadow-2xl shadow-black/50 ring-1 ring-white/5",
                "flex flex-col overflow-hidden",
            )}>
                {/* Search input — typing filters; arrows + enter commit. */}
                <div className={cn(
                    "flex items-center gap-2 px-3 py-2.5 border-b border-glass-border/50",
                    "bg-canvas-base/40",
                )}>
                    <Search className="w-3.5 h-3.5 text-ink-muted shrink-0" strokeWidth={2} />
                    <input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value)
                            setHighlightIndex(0)
                        }}
                        onKeyDown={handleKey}
                        placeholder="Filter conditions…"
                        className={cn(
                            "flex-1 min-w-0 bg-transparent outline-none border-none p-0",
                            "text-sm text-ink placeholder:text-ink-muted/50",
                        )}
                    />
                </div>

                <div className="max-h-[24rem] overflow-y-auto custom-scrollbar py-1">
                    {filtered.length === 0 ? (
                        <div className="px-4 py-6 text-center text-[11px] text-ink-muted leading-snug">
                            No condition matches <span className="font-mono text-ink">{query}</span>.
                        </div>
                    ) : (
                        filtered.map((m, i) => {
                            const Icon = iconFor(m.icon)
                            const isAdvanced = ADVANCED_CATEGORIES.has(m.category)
                            return (
                                <button
                                    key={m.kind}
                                    type="button"
                                    onClick={() => onPick(m.kind)}
                                    onMouseEnter={() => setHighlightIndex(i)}
                                    className={cn(
                                        "w-full flex items-start gap-3 px-3 py-2 text-left transition-colors",
                                        i === highlightIndex
                                            ? "bg-accent-lineage/12"
                                            : "hover:bg-glass/30",
                                    )}
                                >
                                    <span className={cn(
                                        "shrink-0 mt-0.5 rounded-lg p-1.5",
                                        "bg-accent-lineage/10 text-accent-lineage",
                                    )}>
                                        <Icon className="w-3.5 h-3.5" strokeWidth={2} />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-center gap-2">
                                            <span className="text-sm font-medium text-ink leading-tight">
                                                {m.label}
                                            </span>
                                            {isAdvanced && (
                                                <span className="text-[9px] uppercase tracking-wider text-ink-muted/70 px-1 py-0.5 rounded bg-glass/40">
                                                    advanced
                                                </span>
                                            )}
                                        </span>
                                        <span className="block mt-0.5 text-[11px] text-ink-muted leading-snug">
                                            {m.description}
                                        </span>
                                    </span>
                                </button>
                            )
                        })
                    )}
                </div>

                {!query.trim() && (
                    <button
                        type="button"
                        onClick={() => setShowAdvanced((v) => !v)}
                        className={cn(
                            "px-3 py-2 text-[11px] text-ink-muted text-left border-t border-glass-border/50",
                            "hover:bg-glass/30 hover:text-ink transition-colors",
                            "flex items-center justify-between",
                        )}
                    >
                        <span>
                            {showAdvanced ? 'Hide' : 'Show'} advanced (graph topology &amp; scope)
                        </span>
                        <ChevronDown
                            className={cn(
                                "w-3 h-3 transition-transform",
                                showAdvanced && "rotate-180",
                            )}
                            strokeWidth={2}
                        />
                    </button>
                )}
            </div>
        </>
    )
}


function pathsEqual(a: Path, b: Path): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false
    }
    return true
}


// Re-export so consumers don't import LEAF_KINDS from two places
export { LEAF_KINDS }
