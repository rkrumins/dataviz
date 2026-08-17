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
 * group, belonging to nothing. It is a cell of the group now, captioned, so it
 * cannot be mistaken for stray output.
 *
 * The field labels itself through its caller, not a heading of its own: it sits
 * in a settings row whose left-hand words already name it, and repeating them
 * above the control was one of five identical uppercase micro-labels that made
 * a page of distinct settings read as one flat grey. ``label`` survives as the
 * accessible name — which is why the caller must render the SAME words beside
 * it, or the visible label and the spoken one disagree.
 */
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
    // A value no preset offers. The cell is highlighted rather than emptied of
    // its number, because clearing it as you typed "300" would wipe the box on
    // the third keystroke.
    const isCustom = value != null && !presets.includes(value)

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
                {/* The seconds cell. It shows the effective value whichever way
                    it was chosen — including a preset's — because clearing it
                    the moment a typed number happened to match a preset would
                    wipe the box mid-keystroke. It only lights up when the value
                    is one no preset offers. */}
                <input
                    type="number"
                    min={min}
                    max={max}
                    disabled={disabled}
                    aria-label={`${label} (custom, seconds)`}
                    value={value ?? ''}
                    placeholder="Custom"
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
                    <span className="text-ink-muted">
                        Using default ({formatDuration(defaultSecs)})
                    </span>
                ) : (
                    <>
                        <span className="text-ink-secondary font-medium">
                            Overridden: {formatDuration(value)}
                        </span>{' '}
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
