/**
 * personaIntro — whether this browser has been shown what the Business view
 * is, and how to reach every tool. The tip shows until it is dismissed or the
 * persona is changed by any route.
 */
import { useSyncExternalStore } from 'react'


export const PERSONA_INTRO_KEY = 'synodic.persona.intro.v1'

const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
}
/** Seen, where this browser can't store it: for the page's life. */
let seenHere = false

function readSeen(): boolean {
    try {
        return seenHere || localStorage.getItem(PERSONA_INTRO_KEY) === '1'
    } catch {
        return seenHere
    }
}

export function markPersonaIntroSeen(): void {
    if (readSeen()) return
    try { localStorage.setItem(PERSONA_INTRO_KEY, '1') } catch { seenHere = true }
    listeners.forEach((fn) => fn())
}

export function usePersonaIntroSeen(): boolean {
    return useSyncExternalStore(subscribe, readSeen, () => true)
}
