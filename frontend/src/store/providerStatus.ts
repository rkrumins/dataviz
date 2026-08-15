import { useMemo } from 'react'
import { create } from 'zustand'
import { providerService, type ProviderStatusResponse } from '@/services/providerService'
import { onAppVisible } from '@/lib/appVisibility'
import { TOPICS, subscribeToTopic } from '@/store/changeFeed'

export interface ProviderStatusEntry extends ProviderStatusResponse {}

interface ProviderStatusState {
  statuses: Record<string, ProviderStatusEntry>
  lastUpdatedAt: number | null
  /** P4.2 — true when statuses came from localStorage hydration, not a
   * fresh poll. Components can render a subtle "cached" indicator until
   * the first real refresh lands. */
  fromCache: boolean
  /** Epoch ms until which provider polling + the status banner are
   * snoozed, or null when active. Persisted so a snooze survives reload. */
  snoozeUntil: number | null
  refresh: () => Promise<void>
  /** Pause provider polling + the status banner for `ms` milliseconds. */
  snooze: (ms: number) => void
  /** Resume provider polling immediately. */
  unsnooze: () => void
}

const SNOOZE_KEY = 'providerStatusSnoozeV1'

function hydrateSnooze(): number | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(SNOOZE_KEY)
    if (!raw) return null
    const until = Number(raw)
    return Number.isFinite(until) && until > Date.now() ? until : null
  } catch {
    return null
  }
}

function persistSnooze(until: number | null): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (until) localStorage.setItem(SNOOZE_KEY, String(until))
    else localStorage.removeItem(SNOOZE_KEY)
  } catch {
    // non-fatal
  }
}

// P4.2 — persist last-known status to localStorage so a returning visit
// renders the previous truth instantly while the first poll completes.
// Bypasses the cold-start "Computing…" window for typical 30s warmup
// cycles. TTL keeps stale-on-disk entries from masking real changes
// across longer absences (e.g. overnight tab restore).
const PERSIST_KEY = 'providerStatusV1'
const PERSIST_TTL_MS = 5 * 60_000   // 5 minutes

interface PersistedSnapshot {
  statuses: Record<string, ProviderStatusEntry>
  ts: number
}

function hydrateFromStorage(): { statuses: Record<string, ProviderStatusEntry>; ts: number } | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) return null
    const snap = JSON.parse(raw) as PersistedSnapshot
    if (!snap || typeof snap.ts !== 'number') return null
    if (Date.now() - snap.ts > PERSIST_TTL_MS) return null
    return { statuses: snap.statuses ?? {}, ts: snap.ts }
  } catch {
    return null
  }
}

function persistToStorage(statuses: Record<string, ProviderStatusEntry>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      statuses,
      ts: Date.now(),
    } satisfies PersistedSnapshot))
  } catch {
    // localStorage may be full or disabled; non-fatal.
  }
}

// Compare the re-render-relevant fields only. `lastCheckedAt` is a heartbeat
// the backend bumps on every poll and nothing renders it, so comparing it
// would defeat the dedupe and churn a fresh reference each poll.
function statusesEqual(
  a: Record<string, ProviderStatusEntry>,
  b: Record<string, ProviderStatusEntry>,
): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  for (const key of aKeys) {
    const x = a[key]
    const y = b[key]
    if (!y) return false
    if (x.status !== y.status || x.name !== y.name || x.error !== y.error) {
      return false
    }
  }
  return true
}

const initialHydrated = hydrateFromStorage()

export const useProviderStatusStore = create<ProviderStatusState>((set, get) => ({
  statuses: initialHydrated?.statuses ?? {},
  lastUpdatedAt: initialHydrated?.ts ?? null,
  fromCache: initialHydrated !== null,
  snoozeUntil: hydrateSnooze(),

  snooze: (ms: number) => {
    const until = Date.now() + ms
    persistSnooze(until)
    set({ snoozeUntil: until })
    // Nothing to restart: `refreshOnce` reads the snooze on every call, so
    // the pause takes effect at the next signal without touching a timer.
  },

  unsnooze: () => {
    persistSnooze(null)
    set({ snoozeUntil: null })
    // Un-snoozing is the user asking to see current state now, and the
    // subscription only fires on the next transition — so read once here.
    refreshOnce()
  },

  refresh: async () => {
    try {
      const statuses = await providerService.listStatus()
      const map = Object.fromEntries(statuses.map((status) => [status.id, status]))
      persistToStorage(map)
      // Skip the state write when the meaningful snapshot is unchanged so
      // subscribers keep their object references — handing out fresh ones each
      // poll re-runs downstream effects (e.g. ViewExecutionProvider's
      // provider-ready gate) and flickers the canvas. The first poll after
      // localStorage hydration must still write to clear `fromCache`.
      const prev = get()
      if (!prev.fromCache && statusesEqual(prev.statuses, map)) return
      set({
        statuses: map,
        lastUpdatedAt: Date.now(),
        fromCache: false,
      })
    } catch {
      // Keep the previous snapshot. Provider status should never blank the UI.
    }
  },
}))

export function useProviderStatus(providerId: string | null | undefined): ProviderStatusEntry | null {
  return useProviderStatusStore((state) => {
    if (!providerId) return null
    return state.statuses[providerId] ?? null
  })
}

export function useAllProviderStatuses(): ProviderStatusEntry[] {
  const statuses = useProviderStatusStore((state) => state.statuses)
  return useMemo(() => Object.values(statuses), [statuses])
}

/** Snooze controls for the provider status banner. `snoozeUntil` is epoch
 *  ms (or null when active); reads reactively so the banner hides while
 *  snoozed and a "Resume" affordance can show elsewhere. */
export function useProviderSnooze(): {
  snoozeUntil: number | null
  snooze: (ms: number) => void
  unsnooze: () => void
} {
  const snoozeUntil = useProviderStatusStore((s) => s.snoozeUntil)
  const snooze = useProviderStatusStore((s) => s.snooze)
  const unsnooze = useProviderStatusStore((s) => s.unsnooze)
  return { snoozeUntil, snooze, unsnooze }
}

let authReady = false
/** Teardown for the change-topic subscription, or null when not subscribed. */
let unsubscribeTopic: (() => void) | null = null
// `running` is set SYNCHRONOUSLY before the first await; `epoch` invalidates a
// read parked in `await refresh()` when the session ends underneath it.
//
// This file carried the same self-rescheduling-chain defect written up in
// store/providerHealth.ts: the re-entrancy guard tested `pollTimer`, only
// assigned AFTER the await, so every re-entrant call during an in-flight
// request leaked another immortal chain — and restartPolling() made it worse,
// because stopPolling() could not cancel an in-flight poll, so that poll
// survived and re-armed itself on top of the fresh chain. Nothing re-arms
// now, so none of that is reachable.
let running = false
let epoch = 0

function stopPolling() {
  epoch += 1
  running = false
  if (unsubscribeTopic) {
    unsubscribeTopic()
    unsubscribeTopic = null
  }
}

/** Read provider status once. Nothing re-arms; the caller decides when. */
function refreshOnce() {
  if (running || !authReady || typeof document === 'undefined' || document.hidden) return
  // Snoozed: the user asked not to be bothered, and that has to mean no
  // requests, not just no banner.
  const snoozeUntil = useProviderStatusStore.getState().snoozeUntil
  if (snoozeUntil && Date.now() < snoozeUntil) return

  running = true
  const myEpoch = epoch
  void (async () => {
    try {
      if (myEpoch !== epoch) return
      await useProviderStatusStore.getState().refresh()
    } finally {
      if (myEpoch === epoch) running = false
    }
  })()
}

/** Call once after auth resolves. */
export function enableProviderStatusPolling() {
  authReady = true
  // Provider status moves when a provider trips or recovers, and the
  // backend publishes those transitions specifically — not every probe,
  // which would make this noisier than the minute-by-minute poll it
  // replaces.
  if (unsubscribeTopic === null) {
    unsubscribeTopic = subscribeToTopic(TOPICS.providerStatus, refreshOnce)
  }
  refreshOnce()
}

/** Tear the poller down — called when the user lacks ``system:admin``
 *  (or is demoted mid-session). The endpoint is admin-only, so a
 *  non-admin would just 403 every poll without this. Symmetric with
 *  ``enable``; idempotent — the visibilitychange handler already
 *  respects ``authReady``. */
export function disableProviderStatusPolling() {
  authReady = false
  stopPolling()
}

// Coming back to a tab is worth one read: the change feed's transport may
// have been disconnected while it was hidden.
onAppVisible(refreshOnce)
