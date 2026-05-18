/**
 * Inline parameter form for a selected SearchTemplate.
 *
 * Premium treatment to match the rest of the panel:
 *   - Sticky "active template" card at the top with icon + label
 *   - One input per template.inputs, with monospace value field for
 *     property-key style inputs and clear label hierarchy
 *   - Large gradient primary button for Run
 */
import { motion } from 'framer-motion'
import {
    ArrowLeft,
    Loader2,
    Play,
} from 'lucide-react'
import * as LucideIcons from 'lucide-react'
import { type FC } from 'react'

import { cn } from '@/lib/utils'

import {
    type SearchTemplate,
    type TemplateInput,
} from './searchTemplates'


function iconFor(name: string): FC<{ className?: string; strokeWidth?: number }> {
    const Component = (LucideIcons as unknown as Record<
        string, FC<{ className?: string; strokeWidth?: number }>
    >)[name]
    return Component ?? LucideIcons.Sparkles
}


export interface TemplateFormProps {
    template: SearchTemplate
    inputs: Record<string, string | number>
    /** Available entity types in the current view (fills 'entityType' selects). */
    knownEntityTypes: string[]
    isRunning: boolean
    onChange: (name: string, value: string | number) => void
    onRun: () => void
    onBack: () => void
}

export const TemplateForm: FC<TemplateFormProps> = ({
    template, inputs, knownEntityTypes, isRunning,
    onChange, onRun, onBack,
}) => {
    const Icon = iconFor(template.icon)

    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="flex flex-col gap-5"
        >
            {/* Back link */}
            <button
                onClick={onBack}
                className={cn(
                    "self-start inline-flex items-center gap-1.5 px-2 py-1 -ml-2 rounded-lg",
                    "text-[11px] font-medium text-ink-muted",
                    "hover:bg-glass/30 hover:text-ink",
                    "transition-colors",
                )}
            >
                <ArrowLeft className="w-3 h-3" strokeWidth={2.5} />
                All questions
            </button>

            {/* Active template card — visual confirmation of what was picked */}
            <div className={cn(
                "rounded-2xl p-4",
                "bg-gradient-to-br from-accent-lineage/[0.08] via-canvas-elevated/40 to-purple-500/[0.04]",
                "border border-accent-lineage/25",
            )}>
                <div className="flex items-start gap-3">
                    <div className={cn(
                        "shrink-0 w-11 h-11 rounded-xl flex items-center justify-center",
                        "bg-gradient-to-br from-accent-lineage/25 to-purple-500/15",
                        "shadow-sm shadow-accent-lineage/10",
                    )}>
                        <Icon className="w-5 h-5 text-accent-lineage" strokeWidth={2} />
                    </div>
                    <div className="flex-1 min-w-0 pt-0.5">
                        <div className="text-sm font-display font-semibold text-ink leading-tight">
                            {template.label}
                        </div>
                        <p className="mt-1 text-xs text-ink-muted leading-snug">
                            {template.description}
                        </p>
                    </div>
                </div>
            </div>

            {/* Inputs */}
            {template.inputs.length === 0 ? (
                <div className={cn(
                    "rounded-xl px-4 py-3",
                    "bg-glass/30 border border-glass-border/60",
                    "text-xs text-ink-muted text-center",
                )}>
                    No parameters needed — just run the search.
                </div>
            ) : (
                <div className="space-y-4">
                    {template.inputs.map((input) => (
                        <InputField
                            key={input.name}
                            input={input}
                            value={inputs[input.name] ?? ''}
                            onChange={(v) => onChange(input.name, v)}
                            knownEntityTypes={knownEntityTypes}
                        />
                    ))}
                </div>
            )}

            {/* Primary action */}
            <button
                onClick={onRun}
                disabled={isRunning}
                className={cn(
                    "group inline-flex items-center justify-center gap-2",
                    "px-5 py-3 rounded-xl",
                    "bg-gradient-to-r from-accent-lineage to-cyan-500",
                    "text-ink-inverse font-display font-semibold text-sm tracking-tight",
                    "shadow-lg shadow-accent-lineage/25",
                    "hover:shadow-xl hover:shadow-accent-lineage/40",
                    "hover:brightness-110 active:brightness-95",
                    "transition-all",
                    "disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:brightness-100",
                    "focus:outline-none focus:ring-2 focus:ring-accent-lineage/50 focus:ring-offset-2 focus:ring-offset-canvas-elevated",
                )}
            >
                {isRunning ? (
                    <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Running…
                    </>
                ) : (
                    <>
                        <Play className="w-3.5 h-3.5 fill-current transition-transform group-hover:translate-x-0.5" />
                        Run search
                    </>
                )}
            </button>
        </motion.div>
    )
}


function InputField({
    input, value, onChange, knownEntityTypes,
}: {
    input: TemplateInput
    value: string | number
    onChange: (v: string | number) => void
    knownEntityTypes: string[]
}) {
    return (
        <div>
            <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted mb-1.5">
                {input.label}
            </label>
            {input.kind === 'text' && (
                <input
                    type="text"
                    value={String(value)}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={input.placeholder}
                    className={cn(
                        "w-full px-3.5 py-2.5 rounded-xl",
                        "bg-canvas-elevated/60 border border-glass-border",
                        "text-sm text-ink placeholder:text-ink-muted/50",
                        "font-mono",
                        "focus:outline-none focus:border-accent-lineage/50",
                        "focus:ring-2 focus:ring-accent-lineage/20",
                        "hover:border-glass-border/80",
                        "transition-all",
                    )}
                />
            )}
            {input.kind === 'number' && (
                <input
                    type="number"
                    value={Number(value)}
                    onChange={(e) => onChange(Number(e.target.value))}
                    min={input.min}
                    max={input.max}
                    className={cn(
                        "w-full px-3.5 py-2.5 rounded-xl",
                        "bg-canvas-elevated/60 border border-glass-border",
                        "text-sm text-ink tabular-nums font-display",
                        "focus:outline-none focus:border-accent-lineage/50",
                        "focus:ring-2 focus:ring-accent-lineage/20",
                        "hover:border-glass-border/80",
                        "transition-all",
                    )}
                />
            )}
            {input.kind === 'select' && (
                <div className="relative">
                    <select
                        value={String(value)}
                        onChange={(e) => onChange(e.target.value)}
                        className={cn(
                            "w-full px-3.5 py-2.5 pr-9 rounded-xl appearance-none",
                            "bg-canvas-elevated/60 border border-glass-border",
                            "text-sm text-ink",
                            "focus:outline-none focus:border-accent-lineage/50",
                            "focus:ring-2 focus:ring-accent-lineage/20",
                            "hover:border-glass-border/80",
                            "transition-all cursor-pointer",
                        )}
                    >
                        {(input.options.length > 0
                            ? input.options
                            : knownEntityTypes.map((t) => ({ value: t, label: t }))
                        ).map((opt) => (
                            <option key={opt.value} value={opt.value}>
                                {opt.label}
                            </option>
                        ))}
                    </select>
                    <LucideIcons.ChevronDown
                        className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none"
                        strokeWidth={2}
                    />
                </div>
            )}
        </div>
    )
}
