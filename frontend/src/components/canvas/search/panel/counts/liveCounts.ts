/**
 * liveCounts — whether the panel counts conditions as they are built: the
 * Sentence lines, the map, the Ask preview, recipes and type chips.
 *
 * On unless this browser turned it off — on a very large view, where a
 * heavy condition takes a while to count, someone may rather not wait on
 * the numbers. Off, nothing is counted and the numbers don't appear; the
 * search itself still says how many it found.
 */
import { useCallback, useSyncExternalStore } from 'react'


export const LIVE_COUNTS_KEY = 'synodic.advancedSearch.liveCounts'

// Every reader shares the one setting: turning it off in Options stops
// the counts the Sentence view is waiting on.
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
}
/** A setting this browser can't store: kept for the page's life instead. */
let unsaved = true

function savedLiveCounts(): boolean {
    try {
        return localStorage.getItem(LIVE_COUNTS_KEY) !== 'off'
    } catch {
        return unsaved
    }
}

/** Whether conditions are counted as they are built, and how to change it. */
export function useLiveCounts(): [boolean, (on: boolean) => void] {
    const on = useSyncExternalStore(subscribe, savedLiveCounts, () => true)
    const update = useCallback((next: boolean) => {
        try {
            if (next) localStorage.removeItem(LIVE_COUNTS_KEY)
            else localStorage.setItem(LIVE_COUNTS_KEY, 'off')
        } catch {
            unsaved = next
        }
        listeners.forEach((fn) => fn())
    }, [])
    return [on, update]
}
