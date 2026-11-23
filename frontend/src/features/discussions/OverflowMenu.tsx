/**
 * OverflowMenu — the "…" on a thread or a message: a short list of actions. Opens downwards, or
 * upwards near the foot of the window; arrows move through it, Enter picks, Esc closes it (and
 * only it — the drawer around it stays) with focus back on the "…".
 */
import { useEffect, useRef, useState, type ComponentType } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface MenuItem {
    label: string
    icon?: ComponentType<{ className?: string }>
    onSelect: () => void
    danger?: boolean
    hidden?: boolean
}

export function OverflowMenu({ label, items, className, triggerClassName }: {
    /** The button's accessible name ("Message actions"). */
    label: string
    items: readonly MenuItem[]
    className?: string
    triggerClassName?: string
}) {
    const [open, setOpen] = useState<'down' | 'up' | null>(null)
    const root = useRef<HTMLDivElement>(null)
    const trigger = useRef<HTMLButtonElement>(null)
    const shown = items.filter((i) => !i.hidden)

    useEffect(() => {
        if (!open) return
        root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
        const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(null) }
        document.addEventListener('mousedown', away)
        return () => document.removeEventListener('mousedown', away)
    }, [open])

    if (shown.length === 0) return null

    const toggle = () => {
        if (open) { setOpen(null); return }
        const r = trigger.current?.getBoundingClientRect()
        setOpen(r && r.bottom + 40 + shown.length * 32 > window.innerHeight ? 'up' : 'down')
    }
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (!open) return
        const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(null); trigger.current?.focus() }
        else if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(at + 1) % buttons.length]?.focus() }
        else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(at - 1 + buttons.length) % buttons.length]?.focus() }
        else if (e.key === 'Tab') setOpen(null)
    }

    return (
        <div ref={root} className={cn('relative shrink-0', className)} onKeyDown={onKeyDown}>
            <button ref={trigger} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={!!open} onClick={toggle}
                className={cn('w-7 h-7 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 aria-expanded:bg-black/[0.05] dark:aria-expanded:bg-white/[0.08]', triggerClassName)}>
                <MoreHorizontal className="w-4 h-4" aria-hidden />
            </button>
            {open && (
                <div role="menu" aria-label={label}
                    className={cn('absolute right-0 z-30 min-w-[11rem] rounded-xl border border-glass-border/70 bg-canvas-elevated shadow-glass-lg py-1 animate-in fade-in zoom-in-95',
                        open === 'down' ? 'top-full mt-1' : 'bottom-full mb-1')}>
                    {shown.map((item) => {
                        const Icon = item.icon
                        return (
                            <button key={item.label} type="button" role="menuitem"
                                onClick={() => { setOpen(null); item.onSelect() }}
                                className={cn('w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12.5px] focus:outline-none',
                                    'hover:bg-black/[0.04] dark:hover:bg-white/[0.06] focus:bg-black/[0.04] dark:focus:bg-white/[0.06]',
                                    item.danger ? 'text-rose-600 dark:text-rose-300' : 'text-ink')}>
                                {Icon && <Icon className="w-3.5 h-3.5 shrink-0 opacity-80" aria-hidden />}
                                {item.label}
                            </button>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
