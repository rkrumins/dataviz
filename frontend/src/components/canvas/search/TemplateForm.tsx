/**
 * Inline parameter form for a selected SearchTemplate.
 *
 * Renders one field per `template.inputs`, wired to the parent's
 * `setInput` and a "Run search" primary action. Entity-type selects
 * receive their options from props (the parent reads them from the
 * active view's schema so the user only sees types that actually
 * exist in their graph).
 *
 * Keep restrained: this is the "configure the question" step, not a
 * fancy form-builder. One column, labels above inputs, primary
 * action at the bottom.
 */
import { motion } from 'framer-motion'
import { ArrowLeft, Loader2, Play } from 'lucide-react'
import { type FC } from 'react'

import { cn } from '@/lib/utils'

import {
    type SearchTemplate,
    type TemplateInput,
} from './searchTemplates'


export interface TemplateFormProps {
    template: SearchTemplate
    inputs: Record<string, string | number>
    /** Available entity types in the current view (used to fill 'entityType' selects). */
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
    return (
        <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="flex flex-col gap-4"
        >
            {/* Back link + template title */}
            <div>
                <button
                    onClick={onBack}
                    className={cn(
                        "inline-flex items-center gap-1.5 text-xs",
                        "text-ink-muted hover:text-ink",
                        "transition-colors",
                    )}
                >
                    <ArrowLeft className="w-3 h-3" />
                    All questions
                </button>
                <h3 className="mt-2 text-base font-display font-medium text-ink leading-tight">
                    {template.label}
                </h3>
                <p className="text-xs text-ink-muted mt-1 leading-snug">
                    {template.description}
                </p>
            </div>

            {/* Inputs */}
            {template.inputs.length === 0 ? (
                <div className={cn(
                    "px-3 py-2.5 rounded-lg",
                    "bg-glass/30 border border-glass-border/60",
                    "text-xs text-ink-muted",
                )}>
                    No parameters needed — just run.
                </div>
            ) : (
                <div className="space-y-3">
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

            {/* Run action */}
            <button
                onClick={onRun}
                disabled={isRunning}
                className={cn(
                    "inline-flex items-center justify-center gap-2",
                    "px-4 py-2.5 rounded-lg",
                    "bg-accent-lineage text-ink-inverse font-medium text-sm",
                    "hover:brightness-110 active:brightness-95",
                    "shadow-sm transition-all",
                    "disabled:opacity-60 disabled:cursor-not-allowed",
                    "focus:outline-none focus:ring-2 focus:ring-accent-lineage/40",
                )}
            >
                {isRunning ? (
                    <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Running…
                    </>
                ) : (
                    <>
                        <Play className="w-3.5 h-3.5 fill-current" />
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
            <label className="block text-2xs font-medium uppercase tracking-wider text-ink-muted mb-1">
                {input.label}
            </label>
            {input.kind === 'text' && (
                <input
                    type="text"
                    value={String(value)}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={input.placeholder}
                    className={cn(
                        "w-full px-3 py-2 rounded-lg",
                        "bg-canvas-elevated border border-glass-border",
                        "text-sm text-ink placeholder:text-ink-muted/60",
                        "font-mono",
                        "focus:outline-none focus:border-accent-lineage/60",
                        "focus:ring-2 focus:ring-accent-lineage/20",
                        "transition-colors",
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
                        "w-full px-3 py-2 rounded-lg",
                        "bg-canvas-elevated border border-glass-border",
                        "text-sm text-ink tabular-nums",
                        "focus:outline-none focus:border-accent-lineage/60",
                        "focus:ring-2 focus:ring-accent-lineage/20",
                        "transition-colors",
                    )}
                />
            )}
            {input.kind === 'select' && (
                <select
                    value={String(value)}
                    onChange={(e) => onChange(e.target.value)}
                    className={cn(
                        "w-full px-3 py-2 rounded-lg appearance-none",
                        "bg-canvas-elevated border border-glass-border",
                        "text-sm text-ink",
                        "focus:outline-none focus:border-accent-lineage/60",
                        "focus:ring-2 focus:ring-accent-lineage/20",
                        "transition-colors",
                        "cursor-pointer",
                    )}
                >
                    {/* If template ships its own options, use those; otherwise
                        fall back to the view's known entity types. */}
                    {(input.options.length > 0
                        ? input.options
                        : knownEntityTypes.map((t) => ({ value: t, label: t }))
                    ).map((opt) => (
                        <option key={opt.value} value={opt.value}>
                            {opt.label}
                        </option>
                    ))}
                </select>
            )}
        </div>
    )
}
