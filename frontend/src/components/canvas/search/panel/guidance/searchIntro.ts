/**
 * searchIntro — whether this browser has met Search Studio yet. The
 * first-run tip shows until it is dismissed or the Studio is opened.
 */
import { useSyncExternalStore } from 'react'


export const SEARCH_INTRO_KEY = 'synodic.advancedSearch.intro.v1'

const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
}
/** Seen, where this browser can't store it: for the page's life. */
let seenHere = false

function readSeen(): boolean {
    try {
        return seenHere || localStorage.getItem(SEARCH_INTRO_KEY) === '1'
    } catch {
        return seenHere
    }
}

export function markSearchIntroSeen(): void {
    if (readSeen()) return
    try { localStorage.setItem(SEARCH_INTRO_KEY, '1') } catch { seenHere = true }
    listeners.forEach((fn) => fn())
}

export function useSearchIntroSeen(): boolean {
    return useSyncExternalStore(subscribe, readSeen, () => true)
}
