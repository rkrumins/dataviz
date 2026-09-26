import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useRecentSearches, EXPLORER_RECENTS_KEY } from './useRecentSearches'

const PALETTE_RECENTS_KEY = 'nexus.palette.recentSearches'

describe('useRecentSearches', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('defaults to EXPLORER_RECENTS_KEY when no storageKey is passed', () => {
        const { result } = renderHook(() => useRecentSearches())
        act(() => result.current.record('lineage'))
        expect(window.localStorage.getItem(EXPLORER_RECENTS_KEY)).toBe(JSON.stringify(['lineage']))
        expect(window.localStorage.getItem(PALETTE_RECENTS_KEY)).toBeNull()
    })

    it('writes under a custom storageKey when one is passed', () => {
        const { result } = renderHook(() => useRecentSearches(PALETTE_RECENTS_KEY))
        act(() => result.current.record('pipeline'))
        expect(window.localStorage.getItem(PALETTE_RECENTS_KEY)).toBe(JSON.stringify(['pipeline']))
        expect(window.localStorage.getItem(EXPLORER_RECENTS_KEY)).toBeNull()
    })

    it('keeps recents isolated between two different storage keys', () => {
        const explorer = renderHook(() => useRecentSearches())
        const palette = renderHook(() => useRecentSearches(PALETTE_RECENTS_KEY))

        act(() => explorer.result.current.record('sales'))
        act(() => palette.result.current.record('workspaces'))

        expect(explorer.result.current.recents).toEqual(['sales'])
        expect(palette.result.current.recents).toEqual(['workspaces'])
    })

    // The canvas tree does not remount when the user switches view, so the
    // key changes under a live hook. Seeding only on mount left view B
    // offering view A's searches — and recording one wrote it under B's
    // key while the list on screen still said A's.
    it('re-reads when the storage key changes under it', () => {
        window.localStorage.setItem(EXPLORER_RECENTS_KEY, JSON.stringify(['sales']))
        window.localStorage.setItem(PALETTE_RECENTS_KEY, JSON.stringify(['docs']))

        const { result, rerender } = renderHook(
            ({ key }) => useRecentSearches(key),
            { initialProps: { key: EXPLORER_RECENTS_KEY } },
        )
        expect(result.current.recents).toEqual(['sales'])

        rerender({ key: PALETTE_RECENTS_KEY })

        expect(result.current.recents).toEqual(['docs'])
    })

    it('records under the new key only, and leaves the old list alone', () => {
        window.localStorage.setItem(EXPLORER_RECENTS_KEY, JSON.stringify(['sales']))

        const { result, rerender } = renderHook(
            ({ key }) => useRecentSearches(key),
            { initialProps: { key: EXPLORER_RECENTS_KEY } },
        )
        rerender({ key: PALETTE_RECENTS_KEY })
        act(() => result.current.record('orders'))

        expect(JSON.parse(window.localStorage.getItem(PALETTE_RECENTS_KEY) ?? '[]'))
            .toEqual(['orders'])
        expect(JSON.parse(window.localStorage.getItem(EXPLORER_RECENTS_KEY) ?? '[]'))
            .toEqual(['sales'])
    })

    it('reads pre-existing entries for the given storageKey on mount', () => {
        window.localStorage.setItem(PALETTE_RECENTS_KEY, JSON.stringify(['docs', 'settings']))
        const { result } = renderHook(() => useRecentSearches(PALETTE_RECENTS_KEY))
        expect(result.current.recents).toEqual(['docs', 'settings'])
    })
})
