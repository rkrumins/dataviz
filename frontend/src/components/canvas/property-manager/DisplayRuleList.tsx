/**
 * DisplayRuleList — the roster of saved display rules inside the
 * Property Manager. Each card shows the tag chip, the live match count
 * (from ``displayRuleMatchStore``), and enable / edit / delete controls.
 */
import { Pencil, Plus, Trash2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { DisplayRuleConfig } from '@/types/schema'
import { useRuleMatchCount } from '@/store/displayRuleMatchStore'


export interface DisplayRuleListProps {
    rules: DisplayRuleConfig[]
    onNew: () => void
    onEdit: (rule: DisplayRuleConfig) => void
    onToggle: (id: string) => void
    onDelete: (id: string) => void
}


export function DisplayRuleList({
    rules, onNew, onEdit, onToggle, onDelete,
}: DisplayRuleListProps) {
    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
                <p className="text-[11px] text-ink-muted leading-snug max-w-[70%]">
                    Rules tag matched entities on the canvas. Each rule reuses the
                    Advanced-Search criteria to find what to tag.
                </p>
                <button
                    type="button"
                    onClick={onNew}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-accent-lineage text-white hover:bg-accent-lineage/90 shadow-sm shadow-accent-lineage/30 transition-all shrink-0"
                >
                    <Plus className="w-3.5 h-3.5" strokeWidth={2.5} /> New rule
                </button>
            </div>

            {rules.length === 0 ? (
                <div className="rounded-xl border border-dashed border-glass-border/60 px-4 py-8 text-center">
                    <p className="text-sm text-ink font-medium">No display rules yet</p>
                    <p className="mt-1 text-[11px] text-ink-muted leading-snug">
                        Create a rule to tag entities that match a search criteria —
                        e.g. tag everything with a PII classification, or every dataset
                        missing an owner.
                    </p>
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {rules.map((rule) => (
                        <RuleCard
                            key={rule.id}
                            rule={rule}
                            onEdit={() => onEdit(rule)}
                            onToggle={() => onToggle(rule.id)}
                            onDelete={() => onDelete(rule.id)}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}


function RuleCard({
    rule, onEdit, onToggle, onDelete,
}: {
    rule: DisplayRuleConfig
    onEdit: () => void
    onToggle: () => void
    onDelete: () => void
}) {
    const matchCount = useRuleMatchCount(rule.id)

    return (
        <div className={cn(
            'group rounded-xl border bg-canvas-elevated/30 px-3 py-2.5 transition-all',
            rule.enabled ? 'border-glass-border/70' : 'border-glass-border/40 opacity-60',
        )}>
            <div className="flex items-center gap-2.5">
                {/* Enable toggle */}
                <button
                    type="button"
                    onClick={onToggle}
                    role="switch"
                    aria-checked={rule.enabled}
                    title={rule.enabled ? 'Disable rule' : 'Enable rule'}
                    className={cn(
                        'relative w-9 h-5 rounded-full transition-colors shrink-0',
                        rule.enabled ? 'bg-accent-lineage/80' : 'bg-glass/60',
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
                        className="inline-block px-2 py-0.5 rounded-md text-xs font-medium max-w-full truncate align-middle"
                        style={{ backgroundColor: `${rule.color}26`, color: rule.color }}
                        title={rule.name}
                    >
                        {rule.name}
                    </span>
                    <div className="mt-1 text-[10.5px] text-ink-muted tabular-nums">
                        {rule.enabled
                            ? <><span className="text-ink font-semibold">{matchCount}</span> tagged on canvas</>
                            : 'Disabled'}
                    </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
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
                </div>
            </div>
        </div>
    )
}
