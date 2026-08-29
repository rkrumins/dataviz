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

    it('reads pre-existing entries for the given storageKey on mount', () => {
        window.localStorage.setItem(PALETTE_RECENTS_KEY, JSON.stringify(['docs', 'settings']))
        const { result } = renderHook(() => useRecentSearches(PALETTE_RECENTS_KEY))
        expect(result.current.recents).toEqual(['docs', 'settings'])
    })
})
