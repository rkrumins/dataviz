/**
 * useHostRect — where an element sits on screen, kept current as it is
 * resized, the window is, or the page scrolls. Search Studio covers the
 * region the panel and its canvas share with exactly this rectangle.
 */
import { useLayoutEffect, useState } from 'react'


export interface HostRect {
    top: number
    left: number
    width: number
    height: number
}

const same = (a: HostRect | null, b: HostRect) =>
    !!a && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height


export function useHostRect(host: Element | null): HostRect | null {
    const [rect, setRect] = useState<HostRect | null>(null)
    useLayoutEffect(() => {
        if (!host) return
        const measure = () => {
            const r = host.getBoundingClientRect()
            const next = { top: r.top, left: r.left, width: r.width, height: r.height }
            setRect((prev) => (same(prev, next) ? prev : next))
        }
        measure()
        const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        ro?.observe(host)
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, true)
        return () => {
            ro?.disconnect()
            window.removeEventListener('resize', measure)
            window.removeEventListener('scroll', measure, true)
        }
    }, [host])
    return rect
}
