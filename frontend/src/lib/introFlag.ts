/**
 * introFlag — whether this browser has been shown something once: a first-visit tip or coach mark.
 * The flag lives in localStorage under `key`; where the browser can't store it, it holds for the
 * page's life. Every component reading the same flag re-renders once it is marked.
 *
 *   const flag = introFlag('synodic.persona.intro.v1')
 *   flag.useSeen()   // in a component: true once seen
 *   flag.mark()      // anywhere: seen, for good
 */
import { useSyncExternalStore } from 'react'

export interface IntroFlag {
    /** Marks it seen; a no-op once it is. */
    mark: () => void
    /** Whether it has been seen, read now. */
    read: () => boolean
    /** Whether it has been seen; re-renders when it is marked. Seen during server rendering. */
    useSeen: () => boolean
}

export function introFlag(key: string): IntroFlag {
    const listeners = new Set<() => void>()
    const subscribe = (fn: () => void) => {
        listeners.add(fn)
        return () => { listeners.delete(fn) }
    }
    /** Seen, where this browser can't store it: for the page's life. */
    let seenHere = false

    const read = (): boolean => {
        try {
            return seenHere || localStorage.getItem(key) === '1'
        } catch {
            return seenHere
        }
    }

    const mark = (): void => {
        if (read()) return
        try { localStorage.setItem(key, '1') } catch { seenHere = true }
        listeners.forEach((fn) => fn())
    }

    return { mark, read, useSeen: () => useSyncExternalStore(subscribe, read, () => true) }
}
