/**
 * Drag handle on the right edge of the panel that lets the user
 * resize it. Width is clamped to [MIN, MAX] and persisted to
 * localStorage so the panel re-opens at the user's chosen width.
 *
 * The handle is invisible by default and surfaces a subtle accent
 * stripe on hover/drag — premium feel without visual noise.
 */
import { type FC, useCallback, useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'


const STORAGE_KEY = 'advanced-search:panel-width'
const MIN_WIDTH = 380
const MAX_WIDTH = 900
const DEFAULT_WIDTH = 480


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
}


export const ResizeHandle: FC<ResizeHandleProps> = ({ width, onResize }) => {
    const [dragging, setDragging] = useState(false)
    const startXRef = useRef(0)
    const startWidthRef = useRef(width)

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        e.preventDefault()
        startXRef.current = e.clientX
        startWidthRef.current = width
        setDragging(true)
    }, [width])

    // Track move + release on window so the user can drag past the
    // handle without losing focus.
    useEffect(() => {
        if (!dragging) return
        const handleMove = (e: PointerEvent) => {
            const dx = e.clientX - startXRef.current
            const next = Math.max(
                MIN_WIDTH,
                Math.min(MAX_WIDTH, startWidthRef.current + dx),
            )
            onResize(next)
        }
        const handleUp = () => {
            setDragging(false)
            try {
                window.localStorage.setItem(STORAGE_KEY, String(startWidthRef.current))
            } catch {
                // localStorage may be unavailable (e.g. in incognito); silently ignore.
            }
        }
        // Persist on release; read final width via a closure-stable ref.
        const persist = (e: PointerEvent) => {
            const dx = e.clientX - startXRef.current
            const next = Math.max(
                MIN_WIDTH,
                Math.min(MAX_WIDTH, startWidthRef.current + dx),
            )
            try {
                window.localStorage.setItem(STORAGE_KEY, String(next))
            } catch {
                // ignore
            }
            handleUp()
        }
        window.addEventListener('pointermove', handleMove)
        window.addEventListener('pointerup', persist)
        return () => {
            window.removeEventListener('pointermove', handleMove)
            window.removeEventListener('pointerup', persist)
        }
    }, [dragging, onResize])

    return (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize search panel"
            onPointerDown={handlePointerDown}
            className={cn(
                "absolute top-0 right-0 z-30 h-full",
                "w-1.5 -mr-0.5 cursor-col-resize",
                "group flex items-center justify-center",
                "select-none touch-none",
            )}
        >
            <div className={cn(
                "h-16 w-0.5 rounded-full transition-all",
                dragging
                    ? "bg-accent-lineage shadow-[0_0_8px_rgba(99,102,241,0.6)]"
                    : "bg-transparent group-hover:bg-accent-lineage/40",
            )} />
        </div>
    )
}


export { MIN_WIDTH as PANEL_MIN_WIDTH, MAX_WIDTH as PANEL_MAX_WIDTH, DEFAULT_WIDTH as PANEL_DEFAULT_WIDTH }
