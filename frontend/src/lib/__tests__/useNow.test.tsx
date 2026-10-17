/**
 * One clock for the page: every label moves on the same tick, one interval
 * serves them all, and a page with nothing subscribed runs no timer.
 */
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NOW_TICK_MS, useNow } from '@/lib/useNow'

function Clock({ id }: { id: string }) {
    const now = useNow()
    return <span data-testid={id}>{now}</span>
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('useNow', () => {
    it('moves every subscriber together, on one interval', () => {
        const setInterval = vi.spyOn(globalThis, 'setInterval')
        render(<><Clock id="a" /><Clock id="b" /><Clock id="c" /></>)
        expect(setInterval).toHaveBeenCalledTimes(1)

        const before = Number(screen.getByTestId('a').textContent)
        act(() => { vi.advanceTimersByTime(NOW_TICK_MS) })
        const after = Number(screen.getByTestId('a').textContent)
        expect(after).toBeGreaterThanOrEqual(before + NOW_TICK_MS)
        expect(screen.getByTestId('b').textContent).toBe(String(after))
        expect(screen.getByTestId('c').textContent).toBe(String(after))
        setInterval.mockRestore()
    })

    it('stops when the last subscriber leaves, and is current when it comes back', () => {
        const clearInterval = vi.spyOn(globalThis, 'clearInterval')
        const first = render(<Clock id="x" />)
        first.unmount()
        expect(clearInterval).toHaveBeenCalled()

        // A quiet spell with nothing on screen: the next reader is not handed
        // the time from before it.
        vi.advanceTimersByTime(10 * NOW_TICK_MS)
        render(<Clock id="y" />)
        expect(Number(screen.getByTestId('y').textContent)).toBeGreaterThanOrEqual(Date.now() - 1000)
        clearInterval.mockRestore()
    })
})
