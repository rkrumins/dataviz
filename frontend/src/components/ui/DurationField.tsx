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
    label: string
    disabled?: boolean
    min?: number
    max?: number
}

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

    return (
        <div className="space-y-1.5">
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                {label}
            </label>

            <div className="flex flex-wrap items-center gap-1">
                {presets.map((p) => (
                    <button
                        key={p}
                        type="button"
                        disabled={disabled}
                        aria-pressed={value === p}
                        onClick={() => onChange(p)}
                        className={cn(
                            'h-7 px-2 rounded-lg text-xs font-semibold border transition-colors',
                            'disabled:opacity-50 disabled:cursor-not-allowed',
                            value === p
                                ? 'bg-indigo-600 text-white border-indigo-600'
                                : 'bg-canvas text-ink-secondary border-glass-border hover:border-indigo-400',
                        )}
                    >
                        {formatDuration(p)}
                    </button>
                ))}
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
                    className="w-24 h-7 px-2 rounded-lg border border-glass-border bg-canvas text-xs text-ink disabled:opacity-50"
                />
            </div>

            <div className="flex items-center gap-2 text-[11px]">
                {isDefault ? (
                    <span className="text-ink-muted">
                        Using default ({formatDuration(defaultSecs)})
                    </span>
                ) : (
                    <>
                        <span className="text-ink-secondary font-medium">
                            Overridden: {formatDuration(value)}
                        </span>
                        <button
                            type="button"
                            disabled={disabled}
                            onClick={() => onChange(null)}
                            aria-label="Reset to default"
                            className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-50"
                        >
                            <RotateCcw className="w-3 h-3" /> Reset to default
                        </button>
                    </>
                )}
            </div>
        </div>
    )
}
