/**
 * One clock for every relative time on the page.
 *
 * A page of activity or job history shows a hundred "3 min ago"s. Each one
 * running its own timer is a hundred intervals waking the tab to re-render one
 * label each; none at all leaves "just now" on screen for an hour. Every
 * subscriber here shares one interval, running only while something is
 * subscribed, so the labels move together and an idle page costs nothing.
 *
 * Read while nothing is subscribed (the first render after a quiet spell), the
 * clock is brought up to date first — so a label is never painted stale.
 */
import { useSyncExternalStore } from 'react'

/** Relative labels change by the minute; twice a minute is close enough. */
export const NOW_TICK_MS = 30_000

const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined
let now = Date.now()

function tick() {
    now = Date.now()
    listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    if (timer === undefined) timer = setInterval(tick, NOW_TICK_MS)
    return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && timer !== undefined) {
            clearInterval(timer)
            timer = undefined
        }
    }
}

function snapshot(): number {
    // Idle, the clock is not ticking: catch up rather than paint an old "now"
    // (or one from before the machine's clock was set back). Stable within a
    // render — React reads this more than once per render.
    if (timer === undefined) {
        const t = Date.now()
        if (Math.abs(t - now) >= 1000) now = t
    }
    return now
}

/** The current time, in ms, updated for every subscriber at once. */
export function useNow(): number {
    return useSyncExternalStore(subscribe, snapshot, snapshot)
}
