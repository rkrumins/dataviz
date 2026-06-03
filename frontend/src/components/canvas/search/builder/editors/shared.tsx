/**
 * Shared input atoms for the predicate-builder leaf editors.
 *
 * Visual vocabulary matches TemplateForm so the builder feels like
 * the same panel:
 *   - rounded-xl on inputs/selects, rounded-2xl on cards
 *   - bg-canvas-elevated/60 surface, border-glass-border outline
 *   - accent-lineage focus ring
 *   - ink / ink-muted text tones
 */
import { ChevronDown, Check, Plus, X } from 'lucide-react'
import {
    type FC,
    type KeyboardEvent,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
} from 'react'

import { cn } from '@/lib/utils'


export const fieldClass = cn(
    "w-full px-3 py-2 rounded-lg",
    "bg-canvas-elevated/60 border border-glass-border",
    "text-sm text-ink placeholder:text-ink-muted/50",
    "focus:outline-none focus:border-accent-lineage/50",
    "focus:ring-2 focus:ring-accent-lineage/20",
    "hover:border-glass-border/80",
    "transition-all",
)


export const labelClass = "block text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted mb-1"


export function FieldLabel({ children }: { children: React.ReactNode }) {
    return <label className={labelClass}>{children}</label>
}


export function TextField({
    value, onChange, placeholder, mono = false, list,
}: {
    value: string
    onChange: (v: string) => void
    placeholder?: string
    mono?: boolean
    /** datalist id for native autocomplete (props / tag suggestions). */
    list?: string
}) {
    return (
        <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            list={list}
            className={cn(fieldClass, mono && "font-mono")}
        />
    )
}


export function NumberField({
    value, onChange, min, max,
}: {
    value: number
    onChange: (v: number) => void
    min?: number
    max?: number
}) {
    return (
        <input
            type="number"
            value={value}
            onChange={(e) => {
                const n = Number(e.target.value)
                onChange(Number.isFinite(n) ? n : 0)
            }}
            min={min}
            max={max}
            className={cn(fieldClass, "tabular-nums font-display")}
        />
    )
}


export function SelectField<T extends string>({
    value, onChange, options,
}: {
    /** ``undefined`` renders an unselected dropdown. Generic ``T`` is
     *  inferred purely from ``options`` so optional fields whose
     *  generated types are auto-named (`Direction1`, `Op5`, …) still
     *  bind correctly when the caller's typed-options array tells TS
     *  what ``T`` should be. */
    value: T | undefined
    onChange: (v: T) => void
    options: readonly { value: T; label: string; disabled?: boolean }[]
}) {
    return (
        <div className="relative">
            <select
                value={value ?? ''}
                onChange={(e) => onChange(e.target.value as T)}
                className={cn(fieldClass, "pr-9 appearance-none cursor-pointer")}
            >
                {options.map((opt) => (
                    <option key={opt.value} value={opt.value} disabled={opt.disabled}>{opt.label}</option>
                ))}
            </select>
            <ChevronDown
                className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none"
                strokeWidth={2}
            />
        </div>
    )
}


/**
 * Tag-style chip input. The user types a value and presses Enter or
 * comma to commit it as a chip. Existing chips can be removed with
 * the × button or backspace from an empty input. Used for tag values,
 * URN lists, edge-type allowlists, and entity-type multi-select.
 */
export function ChipInput({
    values, onChange, placeholder, suggestions, mono = true,
}: {
    values: readonly string[]
    onChange: (next: string[]) => void
    placeholder?: string
    /** Optional datalist source for native typeahead. */
    suggestions?: readonly string[]
    mono?: boolean
}) {
    const datalistId = useId()
    const [draft, setDraft] = useState('')

    function commit(raw: string) {
        const trimmed = raw.trim()
        if (!trimmed) return
        // De-duplicate on commit. Order-preserving.
        if (values.includes(trimmed)) {
            setDraft('')
            return
        }
        onChange([...values, trimmed])
        setDraft('')
    }

    function handleKey(e: KeyboardEvent<HTMLInputElement>) {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            commit(draft)
        } else if (e.key === 'Backspace' && draft === '' && values.length > 0) {
            onChange(values.slice(0, -1))
        }
    }

    return (
        <div className={cn(
            "rounded-lg bg-canvas-elevated/60 border border-glass-border px-2 py-1.5",
            "focus-within:border-accent-lineage/50 focus-within:ring-2 focus-within:ring-accent-lineage/20",
            "hover:border-glass-border/80 transition-all",
            "flex flex-wrap gap-1.5 items-center",
        )}>
            {values.map((v, i) => (
                <span
                    key={`${v}-${i}`}
                    className={cn(
                        "inline-flex items-center gap-1 px-2 py-0.5 rounded-md",
                        "bg-accent-lineage/15 text-accent-lineage text-xs",
                        mono && "font-mono",
                    )}
                >
                    {v}
                    <button
                        type="button"
                        onClick={() => onChange(values.filter((_, j) => j !== i))}
                        className="hover:text-ink transition-colors"
                        aria-label={`Remove ${v}`}
                    >
                        <X className="w-3 h-3" strokeWidth={2.5} />
                    </button>
                </span>
            ))}
            <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleKey}
                onBlur={() => commit(draft)}
                placeholder={values.length === 0 ? placeholder : undefined}
                list={suggestions ? datalistId : undefined}
                className={cn(
                    "flex-1 min-w-[80px] bg-transparent border-none outline-none",
                    "text-sm text-ink placeholder:text-ink-muted/50 py-0.5",
                    mono && "font-mono",
                )}
            />
            {suggestions && (
                <datalist id={datalistId}>
                    {suggestions.map((s) => <option key={s} value={s} />)}
                </datalist>
            )}
        </div>
    )
}


/**
 * Combobox-style key picker. Designed for the Property / HasProperty
 * editors so business users don't need to know property names by heart.
 *
 *  - Click the field → dropdown opens with all options
 *  - Type to filter — case-insensitive substring match
 *  - Arrow keys + Enter to select; Escape closes
 *  - Click an option to select it
 *  - Falls back to free-text: if the user types a value that isn't in
 *    the options list, the typed value is still emitted (lets queries
 *    work against keys that discovery hasn't surfaced yet — e.g.
 *    pre-W1 blob-stored nodes whose keys haven't been promoted)
 *  - Pure controlled component — `value` and `onChange` are the
 *    source of truth
 */
export function KeyCombobox({
    value, onChange, options, placeholder, mono = true, emptyHint,
}: {
    value: string
    onChange: (next: string) => void
    options: readonly string[]
    placeholder?: string
    mono?: boolean
    /** Shown beneath the dropdown when `options` is empty (e.g. discovery
     *  hasn't loaded). Helps the user understand they can still type
     *  freely. */
    emptyHint?: string
}) {
    const [open, setOpen] = useState(false)
    const [highlightIndex, setHighlightIndex] = useState(0)
    const inputRef = useRef<HTMLInputElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)

    const filtered = useMemo(() => {
        const v = value.trim().toLowerCase()
        if (!v) return options
        // Substring match, case-insensitive.
        return options.filter((o) => o.toLowerCase().includes(v))
    }, [value, options])

    // Outside-click handler — close the dropdown when user clicks away.
    useEffect(() => {
        if (!open) return
        const handler = (e: MouseEvent) => {
            if (!containerRef.current?.contains(e.target as Node)) {
                setOpen(false)
            }
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [open])

    // Clamp the highlighted index whenever the filtered list shrinks.
    useEffect(() => {
        if (highlightIndex >= filtered.length) {
            setHighlightIndex(Math.max(0, filtered.length - 1))
        }
    }, [filtered.length, highlightIndex])

    function commit(v: string) {
        onChange(v)
        setOpen(false)
        inputRef.current?.blur()
    }

    function handleKey(e: KeyboardEvent<HTMLInputElement>) {
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            if (!open) setOpen(true)
            setHighlightIndex((i) => Math.min(filtered.length - 1, i + 1))
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHighlightIndex((i) => Math.max(0, i - 1))
        } else if (e.key === 'Enter') {
            e.preventDefault()
            const pick = filtered[highlightIndex]
            if (pick) {
                commit(pick)
            } else if (value.trim()) {
                // Nothing matched but the user typed something — accept
                // it as a free-text value.
                commit(value.trim())
            }
        } else if (e.key === 'Escape') {
            e.preventDefault()
            setOpen(false)
        }
    }

    return (
        <div ref={containerRef} className="relative">
            <input
                ref={inputRef}
                type="text"
                value={value}
                onChange={(e) => {
                    onChange(e.target.value)
                    if (!open) setOpen(true)
                    setHighlightIndex(0)
                }}
                onFocus={() => setOpen(true)}
                onKeyDown={handleKey}
                placeholder={placeholder}
                role="combobox"
                aria-expanded={open}
                aria-autocomplete="list"
                className={cn(fieldClass, mono && "font-mono", "pr-9")}
            />
            <button
                type="button"
                tabIndex={-1}
                onClick={() => {
                    setOpen((v) => !v)
                    inputRef.current?.focus()
                }}
                className={cn(
                    "absolute right-2 top-1/2 -translate-y-1/2",
                    "p-1 rounded text-ink-muted hover:text-ink hover:bg-glass/40",
                    "transition-colors",
                )}
                aria-label="Toggle dropdown"
            >
                <ChevronDown
                    className={cn(
                        "w-4 h-4 transition-transform",
                        open && "rotate-180",
                    )}
                    strokeWidth={2}
                />
            </button>

            {open && (
                <div
                    className={cn(
                        "absolute left-0 right-0 top-full mt-1 z-20",
                        "rounded-lg border border-glass-border",
                        "bg-canvas-elevated/95 backdrop-blur-md shadow-xl shadow-black/30",
                        "max-h-60 overflow-y-auto py-1",
                    )}
                    role="listbox"
                >
                    {filtered.length === 0 ? (
                        <div className="px-3 py-2 text-[11px] text-ink-muted leading-snug">
                            {value.trim()
                                ? (<>No match for <span className="font-mono text-ink">{value.trim()}</span>. Press Enter to use it anyway.</>)
                                : (emptyHint ?? 'No suggestions available.')
                            }
                        </div>
                    ) : (
                        filtered.map((opt, i) => {
                            const isActive = i === highlightIndex
                            const isPicked = value === opt
                            return (
                                <button
                                    key={opt}
                                    type="button"
                                    onClick={() => commit(opt)}
                                    onMouseEnter={() => setHighlightIndex(i)}
                                    className={cn(
                                        "w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left",
                                        "text-sm transition-colors",
                                        mono && "font-mono",
                                        isActive
                                            ? "bg-accent-lineage/15 text-ink"
                                            : "text-ink/90 hover:bg-glass/30",
                                    )}
                                    role="option"
                                    aria-selected={isPicked}
                                >
                                    <span className="truncate">{opt}</span>
                                    {isPicked && (
                                        <Check className="w-3.5 h-3.5 text-accent-lineage shrink-0" strokeWidth={2.5} />
                                    )}
                                </button>
                            )
                        })
                    )}
                </div>
            )}
        </div>
    )
}


export function MiniButton({
    onClick, children, icon: Icon, variant = 'default',
}: {
    onClick: () => void
    children?: React.ReactNode
    icon?: FC<{ className?: string; strokeWidth?: number }>
    variant?: 'default' | 'danger' | 'accent'
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "inline-flex items-center gap-1 px-2 py-1 rounded-md",
                "text-[11px] font-medium transition-colors",
                variant === 'default' && "text-ink-muted hover:bg-glass/40 hover:text-ink",
                variant === 'danger' && "text-ink-muted hover:bg-red-500/15 hover:text-red-400",
                variant === 'accent' && "text-accent-lineage hover:bg-accent-lineage/15",
            )}
        >
            {Icon && <Icon className="w-3 h-3" strokeWidth={2.5} />}
            {children}
        </button>
    )
}


export { Plus, X }
