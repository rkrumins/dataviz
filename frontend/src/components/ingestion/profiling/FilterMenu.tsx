/**
 * A filter that looks like the product it is in.
 *
 * This replaces a native `<select>`. On macOS that renders as a dark system
 * menu — a different typeface, a different palette and a different corner
 * radius, dropped on top of the page. It is the one control that cannot be
 * styled, so on a surface that cares how it looks it is the one control that
 * must not be used.
 *
 * Options carry an optional glyph, because the provider filter is far quicker
 * to read as a row of logos than as a list of names, and the table it filters
 * shows the same logos.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

import { cn } from '@/lib/utils'

export interface FilterOption {
    key: string
    label: string
    count?: number
    glyph?: React.ComponentType<{ className?: string }>
}

export function FilterMenu({
    label, value, onChange, options, allLabel = 'All', className,
}: {
    label: string
    value: string
    onChange: (next: string) => void
    options: FilterOption[]
    allLabel?: string
    className?: string
}) {
    const [open, setOpen] = useState(false)
    const wrapRef = useRef<HTMLDivElement>(null)

    // Click-outside and Escape, because a popover that can only be dismissed
    // by choosing something is a trap.
    useEffect(() => {
        if (!open) return
        const onDown = (e: MouseEvent) => {
            if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
        }
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onDown)
            document.removeEventListener('keydown', onKey)
        }
    }, [open])

    const selected = options.find((o) => o.key === value)
    const Glyph = selected?.glyph

    return (
        <div ref={wrapRef} className={cn('relative', className)}>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={label}
                className={cn(
                    'inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5',
                    'text-xs font-semibold transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                    selected
                        ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300'
                        : 'border-glass-border bg-canvas-elevated text-ink-muted hover:text-ink',
                )}
            >
                {Glyph && <Glyph className="w-3.5 h-3.5 shrink-0" />}
                <span className="max-w-[10rem] truncate">{selected?.label ?? allLabel}</span>
                <ChevronDown className={cn('w-3.5 h-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
            </button>

            {open && (
                <div
                    role="listbox"
                    aria-label={label}
                    className={cn(
                        'absolute left-0 top-full z-30 mt-1.5 min-w-[13rem] max-h-72 overflow-y-auto',
                        'rounded-xl border border-glass-border bg-canvas-elevated shadow-xl p-1',
                    )}
                >
                    <Option
                        label={allLabel}
                        selected={!value}
                        onSelect={() => { onChange(''); setOpen(false) }}
                    />
                    {options.length > 0 && (
                        <span className="my-1 block h-px bg-glass-border" aria-hidden />
                    )}
                    {options.map((option) => (
                        <Option
                            key={option.key}
                            label={option.label}
                            count={option.count}
                            glyph={option.glyph}
                            selected={value === option.key}
                            onSelect={() => { onChange(option.key); setOpen(false) }}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}

function Option({
    label, count, glyph: Glyph, selected, onSelect,
}: {
    label: string
    count?: number
    glyph?: React.ComponentType<{ className?: string }>
    selected: boolean
    onSelect: () => void
}) {
    return (
        <button
            type="button"
            role="option"
            aria-selected={selected}
            onClick={onSelect}
            className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left',
                'text-xs transition-colors',
                selected
                    ? 'bg-indigo-500/10 text-ink font-semibold'
                    : 'text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink',
            )}
        >
            <Check className={cn('w-3.5 h-3.5 shrink-0', selected ? 'opacity-100 text-indigo-500' : 'opacity-0')} />
            {Glyph && <Glyph className="w-4 h-4 shrink-0" />}
            <span className="flex-1 truncate">{label}</span>
            {count !== undefined && (
                <span className="shrink-0 text-[10px] tabular-nums text-ink-muted">{count}</span>
            )}
        </button>
    )
}
