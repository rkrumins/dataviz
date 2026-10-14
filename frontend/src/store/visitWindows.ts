/**
 * When this browser last saw the Explorer (or a workspace's Views tab) — what
 * "since your last visit" counts from.
 *
 * Its own small persisted store rather than a key in `nexus-preferences`: the
 * heartbeat writes every minute, and rewriting the whole preferences blob that
 * often would be wasteful. Kept per browser because the server keeps no per-person
 * settings; the window is a convenience, and a second device simply has its own.
 *
 * The window runs from the END of the previous visit (its last heartbeat) to the
 * START of this one, so it does not move while you work — the counts on the banner
 * stay the ones you clicked — and it never flags your own changes from earlier in
 * the same visit.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** Away this long and coming back is a new visit. */
export const SESSION_GAP_MS = 30 * 60_000
/** Surfaces not seen for this long are forgotten. */
const KEEP_MS = 180 * 86_400_000
const HEARTBEAT_MS = 60_000

interface VisitRecord {
  /** The latest heartbeat — when this browser last had the surface open. */
  lastSeenAt: number
  /** When the current visit began. */
  sessionStartedAt: number
  /** The end of the previous visit; `null` on a first visit, or once marked seen. */
  windowFrom: number | null
}

interface VisitWindowsState {
  visits: Record<string, VisitRecord>
  touch: (key: string, now: number) => void
  markSeen: (key: string) => void
}

export const useVisitWindowsStore = create<VisitWindowsState>()(
  persist(
    (set) => ({
      visits: {},
      touch: (key, now) => set(state => {
        const rec = state.visits[key]
        const next: VisitRecord = !rec
          ? { lastSeenAt: now, sessionStartedAt: now, windowFrom: null }
          : now - rec.lastSeenAt > SESSION_GAP_MS
            ? { lastSeenAt: now, sessionStartedAt: now, windowFrom: rec.lastSeenAt }
            : { ...rec, lastSeenAt: now }
        const visits: Record<string, VisitRecord> = { [key]: next }
        for (const [k, v] of Object.entries(state.visits)) {
          if (k !== key && now - v.lastSeenAt < KEEP_MS) visits[k] = v
        }
        return { visits }
      }),
      markSeen: (key) => set(state => {
        const rec = state.visits[key]
        return rec ? { visits: { ...state.visits, [key]: { ...rec, windowFrom: null } } } : state
      }),
    }),
    { name: 'nexus-visit-windows', version: 1 },
  ),
)

/** The span "since your last visit" covers, as ISO instants. */
export interface VisitWindow { from: string; to: string }

/**
 * Keep a surface's visit record beating while it is open, and return its window —
 * or `null` on a first visit, or once the reader has marked the changes as seen.
 * `key` is `${userId}:${surface}`; `null` turns it off (nobody signed in).
 */
export function useVisitWindow(key: string | null): VisitWindow | null {
  const rec = useVisitWindowsStore(s => (key ? s.visits[key] : undefined))
  const touch = useVisitWindowsStore(s => s.touch)

  useEffect(() => {
    if (!key) return
    touch(key, Date.now())
    // A heartbeat while the page is in view, and one more as it is left, so
    // "the end of your last visit" is when you actually stopped looking.
    const beatIfVisible = () => { if (document.visibilityState === 'visible') touch(key, Date.now()) }
    const beat = () => touch(key, Date.now())
    const timer = setInterval(beatIfVisible, HEARTBEAT_MS)
    document.addEventListener('visibilitychange', beat)
    window.addEventListener('pagehide', beat)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', beat)
      window.removeEventListener('pagehide', beat)
    }
  }, [key, touch])

  if (!rec?.windowFrom) return null
  return {
    from: new Date(rec.windowFrom).toISOString(),
    to: new Date(rec.sessionStartedAt).toISOString(),
  }
}
