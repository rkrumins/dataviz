/**
 * Live counts: on until this browser turns them off, one setting shared by
 * everything that counts, and still a setting where the browser keeps none.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LIVE_COUNTS_KEY, useLiveCounts } from '../liveCounts'


describe('live counts', () => {
    beforeEach(() => localStorage.clear())
    afterEach(() => vi.restoreAllMocks())

    it('are on until turned off, and remembered off', () => {
        const { result } = renderHook(() => useLiveCounts())
        expect(result.current[0]).toBe(true)
        act(() => result.current[1](false))
        expect(localStorage.getItem(LIVE_COUNTS_KEY)).toBe('off')
        expect(renderHook(() => useLiveCounts()).result.current[0]).toBe(false)
        act(() => result.current[1](true))
        expect(localStorage.getItem(LIVE_COUNTS_KEY)).toBeNull()
    })

    it('are one setting: every reader sees a change at once', () => {
        const options = renderHook(() => useLiveCounts())
        const sentence = renderHook(() => useLiveCounts())
        act(() => options.result.current[1](false))
        expect(sentence.result.current[0]).toBe(false)
    })

    it('still turn off for the page where the browser stores nothing', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
        vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked') })
        const { result } = renderHook(() => useLiveCounts())
        expect(result.current[0]).toBe(true)
        act(() => result.current[1](false))
        expect(result.current[0]).toBe(false)
        act(() => result.current[1](true))
    })
})
