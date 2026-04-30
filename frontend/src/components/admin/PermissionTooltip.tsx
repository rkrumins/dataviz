/**
 * PermissionTooltip — hover popover that translates a cryptic
 * permission id like ``workspace:view:edit`` into something an
 * auditor or non-technical admin can read.
 *
 * Renders an info-icon trigger; on hover (or focus) a framer-motion
 * popover appears with:
 *   - the permission's category chip
 *   - the paragraph-form long description (falls back to short
 *     description when long is null)
 *   - the bulleted examples list (omitted when empty)
 *   - chips of the roles that bundle this permission, when supplied
 *
 * Implementation note (the reason this file exists in its current
 * form): the popover is rendered through a React portal anchored to
 * ``document.body`` and positioned with ``position: fixed`` plus
 * runtime coordinates from the trigger's ``getBoundingClientRect``.
 *
 * The first draft used ``position: absolute`` next to the trigger and
 * looked broken inside the Role-matrix — the matrix lives in a
 * ``overflow-x-auto`` container, and the permission cell is a
 * ``sticky`` ``<td>`` that creates its own stacking context. Both
 * effects clipped or hid the popover. The portal sidesteps the entire
 * containment problem.
 *
 * Visual language matches the toast / AccessDeniedModal style —
 * rounded panel, layered border, tinted icon box, no Radix.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Info, Lock, Briefcase, Zap, Sparkles } from 'lucide-react'
import type { PermissionResponse } from '@/services/permissionsService'
import { cn } from '@/lib/utils'


// Category visual config — kept in-sync with the same constant in
// AdminPermissions.tsx. Lift to a shared module if a third surface
// needs them.
const CATEGORY_VISUAL: Record<string, { label: string; icon: typeof Lock; pill: string }> = {
    system: {
        label: 'System',
        icon: Lock,
        pill: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
    },
    workspace: {
        label: 'Workspace',
        icon: Briefcase,
        pill: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20',
    },
    resource: {
        label: 'Resource',
        icon: Zap,
        pill: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
    },
}


// Popover sizing constants for position math. The popover's actual
// rendered size may differ slightly (content-driven height) but these
// are tight upper bounds used only to keep the panel inside the
// viewport — actual rendering uses ``max-w-[20rem]`` / auto height.
const POPOVER_WIDTH = 320  // matches w-80
const POPOVER_HEIGHT_GUESS = 240
const VIEWPORT_MARGIN = 8
const HOVER_OPEN_DELAY_MS = 120
const HOVER_CLOSE_DELAY_MS = 160


export interface PermissionTooltipProps {
    permission: PermissionResponse
    /**
     * Optional list of role-name chips ("admin", "user", ...) rendered
     * under "Granted to". When omitted, the section is hidden — useful
     * inside the role editor where every row already shows the Granted
     * info inline.
     */
    grantedToRoles?: string[]
    /**
     * Where to anchor the popover relative to the trigger. ``right``
     * floats next to the trigger, vertically centred; ``below`` drops
     * underneath, left-aligned. The component will flip to the
     * opposite side automatically when the preferred side overflows
     * the viewport.
     */
    placement?: 'right' | 'below'
    /**
     * The trigger to render. When omitted, a default ``Info`` icon is
     * used so this component is drop-in next to any permission id.
     */
    children?: React.ReactNode
    /** Larger trigger hit area on tables — defaults to ``sm``. */
    size?: 'sm' | 'md'
}


export function PermissionTooltip({
    permission, grantedToRoles, placement = 'right', children, size = 'sm',
}: PermissionTooltipProps) {
    const [open, setOpen] = useState(false)
    const [coords, setCoords] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
    const id = useId()
    const triggerRef = useRef<HTMLButtonElement>(null)
    const closeTimerRef = useRef<number | null>(null)
    const openTimerRef = useRef<number | null>(null)

    const cancelTimers = () => {
        if (closeTimerRef.current !== null) {
            window.clearTimeout(closeTimerRef.current)
            closeTimerRef.current = null
        }
        if (openTimerRef.current !== null) {
            window.clearTimeout(openTimerRef.current)
            openTimerRef.current = null
        }
    }

    const scheduleOpen = () => {
        cancelTimers()
        openTimerRef.current = window.setTimeout(() => setOpen(true), HOVER_OPEN_DELAY_MS)
    }
    const scheduleClose = () => {
        cancelTimers()
        closeTimerRef.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS)
    }

    useEffect(() => () => cancelTimers(), [])

    // Compute popover coordinates whenever it opens. ``useLayoutEffect``
    // so the panel paints in its final spot rather than animating from
    // the wrong location.
    useLayoutEffect(() => {
        if (!open || !triggerRef.current) return
        const rect = triggerRef.current.getBoundingClientRect()
        const vw = window.innerWidth
        const vh = window.innerHeight

        let top: number
        let left: number

        if (placement === 'below') {
            top = rect.bottom + VIEWPORT_MARGIN
            left = rect.left
            // Flip up if there's no room below.
            if (top + POPOVER_HEIGHT_GUESS > vh - VIEWPORT_MARGIN) {
                const above = rect.top - POPOVER_HEIGHT_GUESS - VIEWPORT_MARGIN
                if (above >= VIEWPORT_MARGIN) top = above
            }
        } else {
            // Right placement, vertically centred on the trigger.
            top = rect.top + rect.height / 2 - POPOVER_HEIGHT_GUESS / 2
            left = rect.right + VIEWPORT_MARGIN
            // Flip to the left if there's no room on the right.
            if (left + POPOVER_WIDTH > vw - VIEWPORT_MARGIN) {
                const onLeft = rect.left - POPOVER_WIDTH - VIEWPORT_MARGIN
                if (onLeft >= VIEWPORT_MARGIN) left = onLeft
            }
        }

        // Clamp to viewport so the panel always stays visible.
        if (left + POPOVER_WIDTH > vw - VIEWPORT_MARGIN) {
            left = vw - POPOVER_WIDTH - VIEWPORT_MARGIN
        }
        if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN
        if (top + POPOVER_HEIGHT_GUESS > vh - VIEWPORT_MARGIN) {
            top = vh - POPOVER_HEIGHT_GUESS - VIEWPORT_MARGIN
        }
        if (top < VIEWPORT_MARGIN) top = VIEWPORT_MARGIN

        setCoords({ top, left })
    }, [open, placement])

    // Reposition while open if the user scrolls or resizes — covers the
    // case where the trigger is inside an internally-scrolled list.
    useEffect(() => {
        if (!open) return
        const handler = () => {
            if (!triggerRef.current) return
            const rect = triggerRef.current.getBoundingClientRect()
            // If the trigger has scrolled out of view, dismiss.
            if (rect.bottom < 0 || rect.top > window.innerHeight) {
                setOpen(false)
                return
            }
            // Recompute by toggling state via the layout effect path.
            setCoords((c) => ({ ...c }))
        }
        window.addEventListener('scroll', handler, { capture: true, passive: true })
        window.addEventListener('resize', handler)
        return () => {
            window.removeEventListener('scroll', handler, { capture: true })
            window.removeEventListener('resize', handler)
        }
    }, [open])

    const cv = CATEGORY_VISUAL[permission.category]
    const CatIcon = cv?.icon ?? Info
    const longText = permission.longDescription ?? permission.description
    const triggerSize = size === 'md' ? 'w-4 h-4' : 'w-3 h-3'

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                aria-describedby={open ? id : undefined}
                aria-label={`What does ${permission.id} allow?`}
                tabIndex={0}
                onMouseEnter={scheduleOpen}
                onMouseLeave={scheduleClose}
                onFocus={() => { cancelTimers(); setOpen(true) }}
                onBlur={() => scheduleClose()}
                onClick={(e) => {
                    e.stopPropagation()
                    cancelTimers()
                    setOpen((o) => !o)
                }}
                className={cn(
                    'inline-flex items-center justify-center rounded-md text-ink-muted',
                    'hover:text-ink hover:bg-black/5 dark:hover:bg-white/5',
                    'focus:outline-none focus:ring-2 focus:ring-emerald-500/40',
                    'transition-colors',
                    size === 'md' ? 'p-1' : 'p-0.5',
                )}
            >
                {children ?? <Info className={triggerSize} />}
            </button>

            {/* Render the popover at body level via a portal so it
                escapes any ``overflow`` / sticky / stacking-context
                trap from the trigger's ancestors. */}
            {typeof document !== 'undefined' && createPortal(
                <AnimatePresence>
                    {open && (
                        <motion.div
                            id={id}
                            role="tooltip"
                            initial={{ opacity: 0, y: 4, scale: 0.96 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 4, scale: 0.96 }}
                            transition={{ duration: 0.12 }}
                            // Keep the popover open while the cursor
                            // is inside it, so the user can read.
                            onMouseEnter={() => { cancelTimers(); setOpen(true) }}
                            onMouseLeave={scheduleClose}
                            style={{
                                position: 'fixed',
                                top: coords.top,
                                left: coords.left,
                                width: POPOVER_WIDTH,
                                maxWidth: 'calc(100vw - 16px)',
                                zIndex: 100,
                            }}
                            className={cn(
                                'bg-canvas-elevated border border-glass-border rounded-xl',
                                'shadow-xl shadow-black/15 dark:shadow-black/40',
                                'p-3 pointer-events-auto',
                            )}
                        >
                            {/* Header */}
                            <div className="flex items-start gap-2 mb-2">
                                {cv && (
                                    <span className={cn(
                                        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold border shrink-0 mt-0.5',
                                        cv.pill,
                                    )}>
                                        <CatIcon className="w-2.5 h-2.5" />
                                        {cv.label.toUpperCase()}
                                    </span>
                                )}
                                <code className="text-[11px] font-mono font-bold text-ink break-all leading-tight flex-1 min-w-0">
                                    {permission.id}
                                </code>
                            </div>

                            {/* Long description (falls back to short) */}
                            <p className="text-xs text-ink-secondary leading-relaxed">
                                {longText || (
                                    <span className="italic text-ink-muted">No description available.</span>
                                )}
                            </p>

                            {/* Examples */}
                            {permission.examples && permission.examples.length > 0 && (
                                <div className="mt-2.5 pt-2.5 border-t border-glass-border">
                                    <div className="flex items-center gap-1 mb-1.5">
                                        <Sparkles className="w-3 h-3 text-emerald-500" />
                                        <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">
                                            Example actions
                                        </span>
                                    </div>
                                    <ul className="space-y-1">
                                        {permission.examples.map((ex, i) => (
                                            <li key={i} className="text-[11px] text-ink-secondary leading-relaxed flex items-start gap-1.5">
                                                <span className="text-emerald-500 shrink-0 mt-px">•</span>
                                                <span className="min-w-0 break-words">{ex}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {/* Granted-to roles */}
                            {grantedToRoles && grantedToRoles.length > 0 && (
                                <div className="mt-2.5 pt-2.5 border-t border-glass-border">
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted block mb-1.5">
                                        Granted to
                                    </span>
                                    <div className="flex flex-wrap gap-1">
                                        {grantedToRoles.map((r) => (
                                            <span
                                                key={r}
                                                className="inline-flex items-center px-1.5 py-px rounded-full text-[10px] font-semibold border bg-glass-base/40 text-ink-secondary border-glass-border"
                                            >
                                                {r}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </motion.div>
                    )}
                </AnimatePresence>,
                document.body,
            )}
        </>
    )
}
