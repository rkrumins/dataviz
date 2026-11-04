/**
 * Drag handle on the edge of a panel that lets the user resize it — the
 * right edge of the search panel by default, or the left edge of a panel
 * docked on the right (the details drawer). Width is clamped to [min, max] —
 * `max` is MAX, or less when the canvas beside the panel needs the room — and
 * kept, so the panel re-opens at the user's chosen width: in localStorage for
 * the search panel, or wherever `onCommit` keeps it.
 *
 * The handle is invisible by default and surfaces a subtle accent
 * stripe on hover/drag — premium feel without visual noise.
 *
 * From the keyboard it is a window splitter: the arrows step it (Shift
 * for bigger steps), Home and End take it to the narrowest and widest.
 */
import { type FC, useCallback, useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'


const STORAGE_KEY = 'advanced-search:panel-width'
const MIN_WIDTH = 380
const MAX_WIDTH = 900
const DEFAULT_WIDTH = 480
const KEY_STEP = 16
const KEY_STEP_BIG = 80


/** Persisted user-chosen width, clamped on read so a bad localStorage
 *  value (e.g. from a previous version with different bounds) never
 *  produces an unusable panel. */
export function readPersistedWidth(): number {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (!raw) return DEFAULT_WIDTH
        const n = Number(raw)
        if (!Number.isFinite(n)) return DEFAULT_WIDTH
        return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, n))
    } catch {
        return DEFAULT_WIDTH
    }
}


export interface ResizeHandleProps {
    /** Current width in px. The handle reports drag-deltas relative to it. */
    width: number
    /** Called continuously during drag with the new (clamped) width. */
    onResize: (next: number) => void
    /** The widest it may go now; MAX when not given. */
    max?: number
    /** A drag starts or ends — the panel follows the pointer without
     *  easing while one is under way. */
    onDragChange?: (dragging: boolean) => void
    /** Which edge of the panel the handle sits on. On the left edge (a panel
     *  docked on the right), dragging left and ArrowLeft widen it. */
    edge?: 'left' | 'right'
    /** The narrowest it may go; MIN when not given. */
    min?: number
    /** Names the handle for assistive tech. */
    label?: string
    /** Keeps the width it was let go at (or stepped to); the search panel's
     *  localStorage entry when not given. */
    onCommit?: (width: number) => void
}


export const ResizeHandle: FC<ResizeHandleProps> = ({
    width, onResize, max = MAX_WIDTH, onDragChange,
    edge = 'right', min = MIN_WIDTH, label = 'Resize search panel', onCommit,
}) => {
    const [dragging, setDragging] = useState(false)
    // How far the pointer moved, as a change of width: a handle on the left
    // edge widens the panel as it is dragged left.
    const sign = edge === 'left' ? -1 : 1
    const startXRef = useRef(0)
    const startWidthRef = useRef(width)

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        e.preventDefault()
        startXRef.current = e.clientX
        startWidthRef.current = width
        setDragging(true)
        onDragChange?.(true)
    }, [width, onDragChange])

    // Track move + release on window so the user can drag past the
    // handle without losing focus.
    useEffect(() => {
        if (!dragging) return
        const handleMove = (e: PointerEvent) => {
            const dx = (e.clientX - startXRef.current) * sign
            const next = Math.max(
                min,
                Math.min(max, startWidthRef.current + dx),
            )
            onResize(next)
        }
        // Persist the width it was let go at. (This once wrote the width
        // the drag STARTED from straight after, so a dragged width was
        // never remembered.)
        const persist = (e: PointerEvent) => {
            const dx = (e.clientX - startXRef.current) * sign
            const next = Math.max(
                min,
                Math.min(max, startWidthRef.current + dx),
            )
            if (onCommit) onCommit(next)
            else try {
                window.localStorage.setItem(STORAGE_KEY, String(next))
            } catch {
                // localStorage may be unavailable (e.g. in incognito); silently ignore.
            }
            setDragging(false)
            onDragChange?.(false)
        }
        window.addEventListener('pointermove', handleMove)
        window.addEventListener('pointerup', persist)
        return () => {
            window.removeEventListener('pointermove', handleMove)
            window.removeEventListener('pointerup', persist)
        }
    }, [dragging, onResize, max, onDragChange, min, sign, onCommit])

    const handleKeyDown = (e: React.KeyboardEvent) => {
        const step = (e.shiftKey ? KEY_STEP_BIG : KEY_STEP) * sign
        const target = e.key === 'ArrowRight' ? width + step
            : e.key === 'ArrowLeft' ? width - step
                : e.key === 'Home' ? min
                    : e.key === 'End' ? max
                        : null
        if (target === null) return
        e.preventDefault()
        const next = Math.max(min, Math.min(max, target))
        onResize(next)
        if (onCommit) onCommit(next)
        else try {
            window.localStorage.setItem(STORAGE_KEY, String(next))
        } catch {
            // ignore
        }
    }

    return (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label={label}
            aria-valuenow={width}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuetext={`${width} pixels wide`}
            tabIndex={0}
            onPointerDown={handlePointerDown}
            onKeyDown={handleKeyDown}
            className={cn(
                edge === 'left' ? "absolute top-0 left-0 z-30 h-full" : "absolute top-0 right-0 z-30 h-full",
                edge === 'left' ? "w-1.5 -ml-0.5 cursor-col-resize" : "w-1.5 -mr-0.5 cursor-col-resize",
                "group flex items-center justify-center",
                "select-none touch-none focus-visible:outline-none",
            )}
        >
            <div className={cn(
                "h-16 w-0.5 rounded-full transition-all",
                dragging
                    ? "bg-accent-lineage shadow-[0_0_8px_rgba(99,102,241,0.6)]"
                    : "bg-transparent group-hover:bg-accent-lineage/40 group-focus-visible:bg-accent-lineage",
            )} />
        </div>
    )
}


export { MIN_WIDTH as PANEL_MIN_WIDTH, MAX_WIDTH as PANEL_MAX_WIDTH, DEFAULT_WIDTH as PANEL_DEFAULT_WIDTH }
