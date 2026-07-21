/**
 * DataSourceActionMenu — the "⋯" lifecycle menu on a data source.
 *
 * The two destructive actions are deliberately DISTINCT, and their weight matches their
 * consequence:
 *
 *   • Offboard (reversible) — decommission the source; it goes to "Recently deleted" and one
 *     click puts it back for the restore window. This is the safe default, so it reads calm.
 *   • Delete permanently (irreversible) — destroys the version history, and — only when the
 *     graph is one WE generated (a managed/versioned graph) — the graph itself. A customer's
 *     external graph is never touched; the confirm dialog states which case applies before the
 *     click. This reads loud: red, and separated by a divider.
 *
 * Each item carries a one-line subtitle so the difference is legible at a glance, not inferred
 * from the verb alone.
 */
import { useState, useRef, useEffect } from 'react'
import { MoreHorizontal, Pencil, Shield, ArchiveX, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface DataSourceActionMenuProps {
    /** Offboard → Recently deleted; the subtitle names the window. Default 30. */
    restoreWindowDays?: number
    onOffboard: () => void
    onDelete: () => void
    onEdit?: () => void
    /** Shown only when the source isn't already primary. */
    onSetPrimary?: () => void
    disabled?: boolean
    /** Menu horizontal anchor. Rows anchor right; drawers can anchor left. */
    align?: 'left' | 'right'
}

export function DataSourceActionMenu({
    restoreWindowDays = 30,
    onOffboard,
    onDelete,
    onEdit,
    onSetPrimary,
    disabled,
    align = 'right',
}: DataSourceActionMenuProps) {
    const [isOpen, setIsOpen] = useState(false)
    const menuRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!isOpen) return
        const handleClick = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setIsOpen(false)
            }
        }
        document.addEventListener('mousedown', handleClick)
        return () => document.removeEventListener('mousedown', handleClick)
    }, [isOpen])

    const run = (fn: () => void) => (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        setIsOpen(false)
        fn()
    }

    return (
        <div ref={menuRef} className="relative">
            <button
                type="button"
                disabled={disabled}
                onClick={e => { e.preventDefault(); e.stopPropagation(); setIsOpen(o => !o) }}
                title="Data source actions"
                aria-label="Data source actions"
                aria-haspopup="menu"
                aria-expanded={isOpen}
                className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-40"
            >
                <MoreHorizontal className="w-4 h-4" />
            </button>

            {isOpen && (
                <div
                    role="menu"
                    onClick={e => { e.preventDefault(); e.stopPropagation() }}
                    className={cn(
                        'absolute top-full mt-1.5 w-64 py-1.5 z-50',
                        'bg-white dark:bg-slate-900 rounded-2xl shadow-xl',
                        'border border-glass-border',
                        'animate-in fade-in slide-in-from-top-1 duration-150',
                        align === 'right' ? 'right-0' : 'left-0',
                    )}
                >
                    {onEdit && (
                        <button
                            role="menuitem"
                            onClick={run(onEdit)}
                            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                        >
                            <Pencil className="w-3.5 h-3.5 shrink-0" />
                            Edit details
                        </button>
                    )}
                    {onSetPrimary && (
                        <button
                            role="menuitem"
                            onClick={run(onSetPrimary)}
                            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                        >
                            <Shield className="w-3.5 h-3.5 shrink-0" />
                            Set as primary
                        </button>
                    )}
                    {(onEdit || onSetPrimary) && (
                        <div className="border-t border-glass-border/60 my-1.5" />
                    )}

                    {/* Offboard — reversible, the safe default. Calm, not red. */}
                    <button
                        role="menuitem"
                        onClick={run(onOffboard)}
                        className="w-full flex items-start gap-2.5 px-3.5 py-2 text-left text-ink hover:bg-amber-500/10 transition-colors group/off"
                    >
                        <ArchiveX className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                        <span className="flex flex-col">
                            <span className="text-sm font-semibold">Offboard</span>
                            <span className="text-[11px] text-ink-muted leading-snug">
                                Move to Recently deleted · restore for {restoreWindowDays} days
                            </span>
                        </span>
                    </button>

                    {/* Delete permanently — irreversible. Loud, and set apart. */}
                    <button
                        role="menuitem"
                        onClick={run(onDelete)}
                        className="w-full flex items-start gap-2.5 px-3.5 py-2 text-left text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                        <Trash2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        <span className="flex flex-col">
                            <span className="text-sm font-semibold">Delete permanently</span>
                            <span className="text-[11px] text-red-500/80 leading-snug">
                                Irreversible · removes version history
                            </span>
                        </span>
                    </button>
                </div>
            )}
        </div>
    )
}
