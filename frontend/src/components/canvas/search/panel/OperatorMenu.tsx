/**
 * OperatorMenu — a clickable pill that opens a portal-mounted menu of
 * predefined operator options. Replaces every `<select>` used for a
 * finite operator enum (text match mode, property op, tag op, etc.).
 *
 *   [contains ▾]  →  click
 *                    ┌──────────────╮
 *                    │ ⌖ contains   │
 *                    │   starts with│
 *                    │   is exactly │
 *                    ╰──────────────╯
 *
 * Why portal-mount: in narrow panels the native `<select>` UA dropdown
 * is cramped, themes inconsistently across OSes, and worst of all
 * clips against the panel's overflow-y scroll container. This menu
 * renders at document.body with measured positioning, escapes every
 * stacking context, and gets full theme control.
 *
 * IMPORTANT: the menu is portal-mounted but rendered WITHOUT
 * AnimatePresence — it unmounts instantly on close. An exit animation on
 * a portaled popover can strand an invisible node (StrictMode
 * double-mount, rapid toggle, or a parent re-render mid-exit) at this
 * z-index over the page, silently swallowing every click until a full
 * refresh. Instant unmount can't strand. The menu still animates IN via
 * initial/animate.
 */
import { motion } from 'framer-motion'
import { Check, ChevronDown } from 'lucide-react'
import {
    type FC,
    type ReactNode,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/utils'


export interface OperatorOption<T extends string> {
    value: T
    label: string
    description?: string
}


export interface OperatorMenuProps<T extends string> {
    value: T
    options: readonly OperatorOption<T>[]
    onChange: (next: T) => void
    /** Optional label shown next to the chip when CLOSED (e.g. small
     *  uppercase "MATCH"). Skip for chips that stand alone. */
    chipPrefix?: ReactNode
    disabled?: boolean
    /** Visual size — sm for tight inline use, md for standalone. */
    size?: 'sm' | 'md'
    /** Width hint for the chip; defaults to "auto" which fits content. */
    minWidth?: number
    /** Aria label for accessibility. */
    ariaLabel?: string
}


interface Coords {
    top: number
    left: number
    width: number
    flipped: boolean
}


export function OperatorMenu<T extends string>({
    value, options, onChange, chipPrefix, disabled, size = 'md',
    minWidth, ariaLabel,
}: OperatorMenuProps<T>) {
    const [open, setOpen] = useState(false)
    const buttonRef = useRef<HTMLButtonElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    const [coords, setCoords] = useState<Coords | null>(null)

    const current = options.find((o) => o.value === value)
    const label = current?.label ?? value

    // Measure + reposition while open. The first render after open=true
    // has coords still null — the menu renders at button-anchored
    // fallback coords (computed lazily below) so it appears IMMEDIATELY
    // and is then refined to flipped/clamped position one frame later.
    useLayoutEffect(() => {
        if (!open) { setCoords(null); return }
        const update = () => {
            const r = buttonRef.current?.getBoundingClientRect()
            if (!r) return
            const menuW = Math.max(r.width, 200)
            const viewportW = window.innerWidth
            const viewportH = window.innerHeight
            const desiredMenuH = 4 + options.length * 36 + 8
            const spaceBelow = viewportH - r.bottom
            const spaceAbove = r.top
            const flipped = spaceBelow < desiredMenuH && spaceAbove > spaceBelow
            const top = flipped ? r.top - 4 : r.bottom + 4
            const left = Math.max(8, Math.min(r.left, viewportW - menuW - 8))
            setCoords({ top, left, width: menuW, flipped })
        }
        update()
        window.addEventListener('resize', update)
        window.addEventListener('scroll', update, true)
        return () => {
            window.removeEventListener('resize', update)
            window.removeEventListener('scroll', update, true)
        }
    }, [open, options.length])

    // Outside click + Escape.
    useEffect(() => {
        if (!open) return
        const onDocClick = (e: MouseEvent) => {
            const t = e.target as Node
            if (buttonRef.current?.contains(t)) return
            if (menuRef.current?.contains(t)) return
            setOpen(false)
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDocClick)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onDocClick)
            document.removeEventListener('keydown', onKey)
        }
    }, [open])

    const pick = useCallback((next: T) => {
        onChange(next)
        setOpen(false)
    }, [onChange])

    // Render the menu either at measured coords OR at a synchronous
    // fallback derived from the button's current rect. Fallback lets
    // the menu appear on the very first frame after open=true, before
    // useLayoutEffect's setCoords has triggered a re-render.
    const renderCoords: Coords | null = (() => {
        if (coords) return coords
        if (!open) return null
        const r = buttonRef.current?.getBoundingClientRect()
        if (!r) return null
        const menuW = Math.max(r.width, 200)
        const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1024
        return {
            top: r.bottom + 4,
            left: Math.max(8, Math.min(r.left, viewportW - menuW - 8)),
            width: menuW,
            flipped: false,
        }
    })()

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                disabled={disabled}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={ariaLabel}
                onClick={() => setOpen((v) => !v)}
                style={minWidth ? { minWidth } : undefined}
                className={cn(
                    'inline-flex items-center gap-1.5 rounded-lg transition-all',
                    'bg-canvas-elevated/60 border border-glass-border',
                    'text-ink hover:border-accent-lineage/50',
                    'focus:outline-none focus:border-accent-lineage/60',
                    'focus:ring-2 focus:ring-accent-lineage/20',
                    size === 'sm'
                        ? 'px-2.5 py-1.5 text-[12px]'
                        : 'px-3 py-2 text-[13px]',
                    open && 'border-accent-lineage/60 ring-2 ring-accent-lineage/15',
                    disabled && 'opacity-50 cursor-not-allowed',
                )}
            >
                {chipPrefix && (
                    <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-ink-muted">
                        {chipPrefix}
                    </span>
                )}
                <span className="font-medium leading-none truncate">
                    {label}
                </span>
                <ChevronDown className={cn(
                    'w-3.5 h-3.5 text-ink-muted shrink-0 transition-transform',
                    open && 'rotate-180',
                )} />
            </button>

            {typeof document !== 'undefined' && createPortal(
                <>
                    {open && renderCoords && (
                        <motion.div
                            ref={menuRef}
                            initial={{ opacity: 0, y: renderCoords.flipped ? 4 : -4, scale: 0.97 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            transition={{ duration: 0.12 }}
                            style={{
                                position: 'fixed',
                                top: renderCoords.flipped ? undefined : renderCoords.top,
                                bottom: renderCoords.flipped
                                    ? (window.innerHeight - renderCoords.top)
                                    : undefined,
                                left: renderCoords.left,
                                width: renderCoords.width,
                                zIndex: 9999,
                            }}
                            className={cn(
                                'rounded-xl border border-glass-border bg-canvas-elevated',
                                'shadow-2xl shadow-black/50 overflow-hidden',
                                'flex flex-col py-1',
                            )}
                            role="listbox"
                        >
                            {options.map((opt) => {
                                const active = opt.value === value
                                return (
                                    <button
                                        key={opt.value}
                                        type="button"
                                        role="option"
                                        aria-selected={active}
                                        onClick={() => pick(opt.value)}
                                        className={cn(
                                            'w-full flex items-start gap-2 px-3 py-2 text-left',
                                            'transition-colors',
                                            active
                                                ? 'bg-accent-lineage/12 text-accent-lineage'
                                                : 'text-ink hover:bg-glass/40',
                                        )}
                                    >
                                        <Check className={cn(
                                            'w-3.5 h-3.5 mt-0.5 shrink-0',
                                            active ? 'opacity-100' : 'opacity-0',
                                        )} />
                                        <div className="flex-1 min-w-0">
                                            <div className="text-[12.5px] font-medium leading-tight">
                                                {opt.label}
                                            </div>
                                            {opt.description && (
                                                <div className="text-[10.5px] text-ink-muted/80 leading-snug mt-0.5">
                                                    {opt.description}
                                                </div>
                                            )}
                                        </div>
                                    </button>
                                )
                            })}
                        </motion.div>
                    )}
                </>,
                document.body,
            )}
        </>
    )
}


// Backward-compatible alias for callsites that prefer the FC-style import.
export const OperatorMenuFC = OperatorMenu as FC<OperatorMenuProps<string>>
