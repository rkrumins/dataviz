/**
 * One leaf row in the predicate tree.
 *
 * Layout (left → right):
 *   [icon][label][editor body]                           [⋮ menu] [×]
 *
 * The label and icon come from `LeafKinds`. The body is the type-aware
 * editor from `editors/` indexed on `value.kind`. The trailing menu
 * lets the user wrap the leaf in a group (AND/OR/NOT) when they want
 * to start composing — wrapping is also available on the group itself.
 */
import { Trash2 } from 'lucide-react'
import * as LucideIcons from 'lucide-react'
import { type FC } from 'react'

import { cn } from '@/lib/utils'
import type { Predicate } from '@/types/search'

import { LeafEditor, type EditorContext } from './editors'
import { findLeafKind, type LeafKind } from './leafKinds'
import { type Path, type ValidationIssue } from './useBuilderReducer'
import { MiniButton } from './editors/shared'


function iconFor(name: string): FC<{ className?: string; strokeWidth?: number }> {
    const Component = (LucideIcons as unknown as Record<
        string, FC<{ className?: string; strokeWidth?: number }>
    >)[name]
    return Component ?? LucideIcons.Sparkles
}


export interface PredicateRowProps {
    path: Path
    value: Predicate
    ctx: EditorContext
    issues: ValidationIssue[]
    onUpdate: (path: Path, next: Predicate) => void
    onRemove: (path: Path) => void
}


export function PredicateRow({
    path, value, ctx, issues, onUpdate, onRemove,
}: PredicateRowProps) {
    if (value.kind === 'group') return null  // GroupRow handles groups

    const meta = findLeafKind(value.kind as LeafKind)
    const Icon = iconFor(meta?.icon ?? 'Sparkles')

    const ownIssues = issues.filter((i) => pathsEqual(i.path, path))
    const hasErr = ownIssues.some((i) => i.severity === 'error')
    const hasWarn = !hasErr && ownIssues.some((i) => i.severity === 'warn')

    return (
        <div
            data-validation={hasErr ? 'error' : hasWarn ? 'warn' : 'ok'}
            className={cn(
                "group rounded-xl border bg-canvas-elevated/40",
                hasErr
                    ? "border-rose-500/60 ring-1 ring-rose-500/30"
                    : hasWarn
                        ? "border-amber-500/50 ring-1 ring-amber-500/15"
                        : "border-glass-border/60",
                "px-3 py-2.5",
                "hover:border-glass-border transition-colors",
            )}
        >
            <div className="flex items-start gap-2.5">
                {/* Icon + label — sentence-case, conversational tone for business users. */}
                <div className="shrink-0 flex items-center gap-1.5 pt-1.5 min-w-[7rem]">
                    <Icon className="w-3.5 h-3.5 text-accent-lineage" strokeWidth={2} />
                    <span className="text-xs font-medium text-ink leading-tight">
                        {meta?.label ?? value.kind}
                    </span>
                </div>

                {/* Body */}
                <div className="flex-1 min-w-0">
                    <LeafEditor
                        value={value}
                        onChange={(next) => onUpdate(path, next)}
                        ctx={ctx}
                    />
                </div>

                {/* Trailing actions */}
                <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity pt-1">
                    <MiniButton
                        onClick={() => onRemove(path)}
                        icon={Trash2}
                        variant="danger"
                    />
                </div>
            </div>

            {/* Inline issues */}
            {ownIssues.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
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
        </div>
    )
}


function pathsEqual(a: Path, b: Path): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false
    }
    return true
}
