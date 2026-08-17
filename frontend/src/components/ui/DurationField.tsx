/**
 * DurationField — a duration as presets in natural units, with "default" as a
 * state you can see and choose rather than an empty box.
 *
 * Two failures it exists to prevent, both from the cadence dialog it replaces:
 * adjacent stages of one pipeline asking for minutes, minutes and seconds, so
 * the operator does the unit arithmetic; and a literal 0 sitting in a field
 * whose helper text said "leave blank to use the default", which made the
 * current state genuinely unreadable. Null is the ONLY way to say "default",
 * so 0 is free to mean zero.
 *
 * The presets and the free-text box are ONE segmented control. They were two
 * things — a row of chips with an unlabelled number box loose underneath — and
 * that box read as a rendering bug: a bare ``300`` floating below a control
 * group, belonging to nothing. It is a cell of the group now.
 *
 * That cell — and the caption beside it — say something only when they have
 * something to say. Echoing a chosen preset there put the same duration on the
 * row three times in two units (``[1m] 60 · Overridden: 1m``), so the last
 * cell read as a fifth preset labelled in seconds. In a control whose entire
 * reason for existing is that operators should never convert between minutes
 * and seconds, that was worse than the orphan box it replaced.
 *
 * The field labels itself through its caller, not a heading of its own: it sits
 * in a settings row whose left-hand words already name it, and repeating them
 * above the control was one of five identical uppercase micro-labels that made
 * a page of distinct settings read as one flat grey. ``label`` survives as the
 * accessible name — which is why the caller must render the SAME words beside
 * it, or the visible label and the spoken one disagree.
 */
import { useState } from 'react'
import { RotateCcw } from 'lucide-react'

import { cn } from '@/lib/utils'

export interface DurationFieldProps {
    /** Seconds, or null meaning "inherit the default". */
    value: number | null
    onChange: (secs: number | null) => void
    /** Offered presets, in seconds. */
    presets: number[]
    /** The effective default, shown while `value` is null. */
    defaultSecs: number
    /** Not rendered. The accessible name, which the caller also renders as the
     *  visible label of the row this sits in. */
    label: string
    disabled?: boolean
    min?: number
    max?: number
}

/** The spinners are 16px of chrome inside a field that is mostly digits, and
 *  they were wide enough to clip the values they sat next to. */
const NO_SPINNER =
    '[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none '
    + '[&::-webkit-inner-spin-button]:appearance-none'

/** Largest natural unit, so 300 reads "5m" rather than "300s". */
export function formatDuration(secs: number): string {
    if (secs >= 3600 && secs % 3600 === 0) return `${secs / 3600}h`
    if (secs >= 60 && secs % 60 === 0) return `${secs / 60}m`
    return `${secs}s`
}

export function DurationField({
    value, onChange, presets, defaultSecs, label,
    disabled = false, min = 0, max = 86400,
}: DurationFieldProps) {
    const isDefault = value == null
    /** A value no preset offers — the only state the seconds cell has anything
     *  to add, since otherwise the lit chip has already said it. */
    const isCustom = value != null && !presets.includes(value)
    /** While the box has the caret it always shows the raw value, preset or
     *  not. Hiding preset matches unconditionally would wipe the field on the
     *  third keystroke of typing "300" — 30 is a preset on the way past. */
    const [typing, setTyping] = useState(false)
    const shown = value == null ? '' : (typing || isCustom) ? String(value) : ''

    return (
        <div
            role="group"
            aria-label={label}
            className="flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1"
        >
            <div
                className={cn(
                    'inline-flex items-stretch rounded-lg border border-glass-border bg-canvas',
                    'divide-x divide-glass-border overflow-hidden',
                    disabled && 'opacity-50',
                )}
            >
                {presets.map((p) => (
                    <button
                        key={p}
                        type="button"
                        disabled={disabled}
                        aria-pressed={value === p}
                        onClick={() => onChange(p)}
                        className={cn(
                            'h-7 px-2 text-[11px] font-semibold tabular-nums',
                            'transition-colors motion-reduce:transition-none',
                            'outline-none focus-visible:relative focus-visible:z-10',
                            'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500',
                            'disabled:cursor-not-allowed',
                            value === p
                                ? 'bg-indigo-600 text-white'
                                : 'text-ink-secondary hover:bg-indigo-500/10',
                        )}
                    >
                        {formatDuration(p)}
                    </button>
                ))}
                {/* The seconds cell: empty (and offering itself) unless the
                    value is genuinely one no preset covers. */}
                <input
                    type="number"
                    min={min}
                    max={max}
                    disabled={disabled}
                    aria-label={`${label} (custom, seconds)`}
                    value={shown}
                    placeholder="Custom"
                    onFocus={() => setTyping(true)}
                    onBlur={() => setTyping(false)}
                    onChange={(e) => {
                        const raw = e.target.value.trim()
                        onChange(raw === '' ? null : Number(raw))
                    }}
                    className={cn(
                        'w-[74px] h-7 px-2 bg-transparent border-0',
                        'text-[11px] tabular-nums text-ink placeholder:text-ink-muted/70',
                        'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500',
                        'disabled:cursor-not-allowed',
                        isCustom && 'bg-indigo-500/10 font-semibold',
                        NO_SPINNER,
                    )}
                />
            </div>

            <span className="text-[11px]">
                {isDefault ? (
                    // Not redundant: no chip is lit in this state, so this is
                    // the only place the effective duration appears at all.
                    <span className="text-ink-muted">
                        Using default ({formatDuration(defaultSecs)})
                    </span>
                ) : (
                    <>
                        {/* Named only when no chip is naming it already. */}
                        {isCustom && (
                            <span className="text-ink-secondary font-medium">
                                Overridden: {formatDuration(value)}{' '}
                            </span>
                        )}
                        {/* Shown short, spoken long. The row is already dense,
                            but "Reset" on its own says nothing about what it
                            resets to — and the answer is the whole point of
                            this control. */}
                        <button
                            type="button"
                            disabled={disabled}
                            onClick={() => onChange(null)}
                            aria-label="Reset to default"
                            className={cn(
                                'inline-flex items-center gap-1 align-baseline rounded',
                                'text-indigo-600 dark:text-indigo-400 hover:underline',
                                'disabled:opacity-50 disabled:cursor-not-allowed',
                                'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                            )}
                        >
                            <RotateCcw aria-hidden className="w-3 h-3" /> Reset
                        </button>
                    </>
                )}
            </span>
        </div>
    )
}
