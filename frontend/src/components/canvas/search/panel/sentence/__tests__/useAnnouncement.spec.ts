/**
 * A live region that says where things settle: the first thing at once,
 * then at most once every 1.5 s, the newest message waiting its turn.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAnnouncement } from '../useAnnouncement'


describe('useAnnouncement', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('says the first thing at once, then only where things settle', () => {
        const { result, rerender } = renderHook(({ message }) => useAnnouncement(message),
            { initialProps: { message: '' } })
        expect(result.current).toBe('')
        rerender({ message: '12 matches.' })
        act(() => { vi.advanceTimersByTime(0) })
        expect(result.current).toBe('12 matches.')

        rerender({ message: '8 matches.' })
        rerender({ message: '3 matches.' })
        act(() => { vi.advanceTimersByTime(1000) })
        expect(result.current).toBe('12 matches.')
        act(() => { vi.advanceTimersByTime(500) })
        expect(result.current).toBe('3 matches.')

        // Still counting: what it said stands.
        rerender({ message: '' })
        act(() => { vi.advanceTimersByTime(2000) })
        expect(result.current).toBe('3 matches.')
    })
})
