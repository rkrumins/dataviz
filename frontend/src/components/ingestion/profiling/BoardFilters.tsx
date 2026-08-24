/**
 * The board's controls.
 *
 * Deliberately one row of affordances rather than a settings panel: an
 * operator opens this asking "what moved", and every control here is a way of
 * narrowing that question — never a preference to configure first.
 *
 * Search is client-side on purpose. The board is already bounded to a page of
 * sources, and a round trip per keystroke would make filtering feel slower
 * than reading the list.
 */
import { Search, X } from 'lucide-react'

import { cn } from '@/lib/utils'

export interface SegmentedOption<T extends string> { key: T; label: string }

export function Segmented<T extends string>({
    label, options, value, onChange, size = 'md',
}: {
    label: string
    options: readonly SegmentedOption<T>[]
    value: T
    onChange: (next: T) => void
    size?: 'sm' | 'md'
}) {
    return (
        <div
            role="group" aria-label={label}
            className="inline-flex rounded-xl bg-canvas p-0.5 border border-glass-border"
        >
            {options.map((option) => (
                <button
                    key={option.key}
                    type="button"
                    aria-pressed={value === option.key}
                    onClick={() => onChange(option.key)}
                    className={cn(
                        'font-semibold rounded-[10px] transition-colors whitespace-nowrap',
                        size === 'sm' ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1.5 text-xs',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
                        // A ring, because the selected chip is
                        // `bg-canvas-elevated` sitting inside a card that is
                        // ALSO `bg-canvas-elevated` — without an edge it reads
                        // as a hole punched in the track rather than as the
                        // raised, chosen one.
                        value === option.key
                            ? 'bg-canvas-elevated text-ink shadow-sm ring-1 ring-glass-border'
                            : 'text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
                    )}
                >
                    {option.label}
                </button>
            ))}
        </div>
    )
}

export function SearchField({
    value, onChange, placeholder,
}: { value: string; onChange: (next: string) => void; placeholder: string }) {
    return (
        <div className="relative">
            <Search
                className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted pointer-events-none"
                aria-hidden
            />
            <input
                type="search"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                aria-label={placeholder}
                className={cn(
                    'w-full sm:w-56 rounded-xl border border-glass-border bg-canvas',
                    'pl-8 pr-7 py-1.5 text-xs text-ink placeholder:text-ink-muted',
                    'focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/40',
                )}
            />
            {value && (
                <button
                    type="button"
                    onClick={() => onChange('')}
                    aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink"
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            )}
        </div>
    )
}

export function FilterSelect<T extends string>({
    label, value, onChange, options,
}: {
    label: string
    value: T | ''
    onChange: (next: T | '') => void
    options: { key: T; label: string; count?: number }[]
}) {
    return (
        <select
            aria-label={label}
            value={value}
            onChange={(e) => onChange(e.target.value as T | '')}
            className={cn(
                'rounded-xl border border-glass-border bg-canvas px-2.5 py-1.5',
                'text-xs font-semibold text-ink',
                'focus:outline-none focus:ring-2 focus:ring-indigo-500/50',
            )}
        >
            <option value="">{label}</option>
            {options.map((o) => (
                <option key={o.key} value={o.key}>
                    {o.label}{o.count !== undefined ? ` (${o.count})` : ''}
                </option>
            ))}
        </select>
    )
}

export function Toggle({
    checked, onChange, label,
}: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
    return (
        <label className={cn(
            'inline-flex items-center gap-2 rounded-xl border px-2.5 py-1.5',
            'text-xs font-semibold cursor-pointer transition-colors select-none',
            checked
                ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300'
                : 'border-glass-border bg-canvas text-ink-muted hover:text-ink',
        )}>
            <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                className="sr-only"
            />
            <span
                aria-hidden
                className={cn(
                    'w-3.5 h-3.5 rounded border flex items-center justify-center',
                    checked ? 'bg-indigo-600 border-indigo-600' : 'border-glass-border',
                )}
            >
                {checked && (
                    <svg viewBox="0 0 10 8" className="w-2.5 h-2 text-white" fill="none">
                        <path d="M1 4l2.5 2.5L9 1" stroke="currentColor" strokeWidth="2"
                            strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                )}
            </span>
            {label}
        </label>
    )
}

/**
 * A labelled control group.
 *
 * The label is not decoration. Two segmented groups side by side read as one
 * long toolbar, and when one of them offers "Relationships" while its
 * neighbour offers "Relationship types", a reader has no way to tell that
 * those are answers to different questions. Naming the question fixes it;
 * spacing alone does not.
 */
export function ControlGroup<T extends string>({
    label, options, value, onChange, size = 'sm',
}: {
    label: string
    options: readonly SegmentedOption<T>[]
    value: T
    onChange: (next: T) => void
    size?: 'sm' | 'md'
}) {
    return (
        <div className="flex items-center gap-2 min-w-0">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted shrink-0">
                {label}
            </span>
            <Segmented
                label={label} options={options} value={value}
                onChange={onChange} size={size}
            />
        </div>
    )
}
