/**
 * One choice from a few, as a pill: names the filter until something is
 * picked, then names the pick. The Views Explorer's `FilterDropdown` is the
 * same look for choosing several; this is its single-choice twin, so it
 * closes on a pick and offers "Any" to undo it.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, type LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

export interface Choice<T extends string> {
    value: T
    label: string
    /** A dot in the option's own colour (a Tailwind `bg-` class). */
    dot?: string
}

export function ChoicePill<T extends string>({ icon: Icon, label, anyLabel, value, choices, onChange }: {
    icon: LucideIcon
    /** What the pill filters, e.g. "Outcome" — also its accessible name. */
    label: string
    /** The first option, which clears the filter. */
    anyLabel: string
    value: T | null
    choices: Choice<T>[]
    onChange: (value: T | null) => void
}) {
    const [open, setOpen] = useState(false)
    const root = useRef<HTMLDivElement>(null)
    const options = useRef<Array<HTMLButtonElement | null>>([])
    const picked = choices.find((c) => c.value === value) ?? null
    const all: { value: T | null; label: string; dot?: string }[] = [{ value: null, label: anyLabel }, ...choices]

    useEffect(() => {
        if (!open) return
        const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
        document.addEventListener('mousedown', away)
        return () => document.removeEventListener('mousedown', away)
    }, [open])

    const choose = (next: T | null) => {
        onChange(next)
        setOpen(false)
        root.current?.querySelector<HTMLButtonElement>('button[aria-haspopup]')?.focus()
    }

    return (
        <div ref={root} className="relative">
            <button
                type="button"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={picked ? `${label}: ${picked.label}` : label}
                onClick={() => setOpen((o) => !o)}
                className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                    picked
                        ? 'bg-accent-lineage/10 text-accent-lineage'
                        : 'text-ink-secondary hover:bg-black/[0.04] hover:text-ink dark:hover:bg-white/[0.05]',
                )}
            >
                {picked?.dot
                    ? <span aria-hidden className={cn('h-2 w-2 rounded-full', picked.dot)} />
                    : <Icon className="h-3.5 w-3.5" aria-hidden />}
                {picked ? picked.label : label}
                <ChevronDown aria-hidden className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
            </button>
            {open && (
                <div
                    role="listbox"
                    aria-label={label}
                    onKeyDown={(e) => {
                        const at = options.current.indexOf(document.activeElement as HTMLButtonElement)
                        if (e.key === 'Escape') {
                            e.stopPropagation()
                            choose(value)
                        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                            e.preventDefault()
                            const step = e.key === 'ArrowDown' ? 1 : -1
                            options.current[(at + step + all.length) % all.length]?.focus()
                        }
                    }}
                    className="absolute left-0 top-full z-40 mt-1.5 min-w-[11rem] overflow-hidden rounded-xl border border-glass-border bg-canvas-elevated p-1 shadow-xl"
                >
                    {all.map((c, i) => {
                        const on = c.value === value
                        return (
                            <button
                                key={c.value ?? '__any'}
                                ref={(el) => { options.current[i] = el }}
                                type="button"
                                role="option"
                                aria-selected={on}
                                // Opens on the current choice: Enter keeps it, arrows move from it.
                                autoFocus={on}
                                onClick={() => choose(c.value)}
                                className={cn(
                                    'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs outline-none transition-colors',
                                    'hover:bg-black/[0.04] focus-visible:bg-accent-lineage/10 dark:hover:bg-white/[0.05]',
                                    on ? 'font-semibold text-ink' : 'text-ink-secondary',
                                    i === 0 && 'mb-0.5',
                                )}
                            >
                                <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', c.dot ?? 'bg-transparent')} />
                                <span className="flex-1">{c.label}</span>
                                {on && <Check aria-hidden className="h-3.5 w-3.5 text-accent-lineage" />}
                            </button>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
