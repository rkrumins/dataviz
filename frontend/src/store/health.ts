/**
 * Backend health monitoring store.
 *
 * Polls /api/v1/health periodically and accepts failure reports from authFetch.
 * Drives the BackendHealthBanner with four states:
 *   healthy → unreachable → recovered → healthy
 *
 * Anti-flapping: requires 2 consecutive failures before surfacing the banner.
 * Adaptive polling: 30s when healthy, 5s when unhealthy.
 *
 * Only /health probe failures (and navigator.onLine === false) count toward
 * ``consecutiveFailures``. An app-request failure does NOT count directly —
 * a slow-but-alive backend times out app requests while /health (zero-I/O,
 * constant-time on the BE) still answers instantly. Instead it triggers one
 * debounced verification probe: a real outage fails the probe fast
 * (connection refused) and climbs the counter; mere slowness resets it.
 */
import { create } from 'zustand'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'

export type HealthStatus = 'healthy' | 'unreachable' | 'recovered'
export type HealthReason = 'none' | 'network-offline' | 'backend-down'

interface HealthState {
  status: HealthStatus
  reason: HealthReason
  /** Human-readable explanation shown in the banner. */
  detail: string | null
  lastCheckedAt: number | null
  consecutiveFailures: number

  poll: () => Promise<void>
  reportFailure: (err: unknown) => void
  clearRecovery: () => void
}

const HEALTH_URL = '/api/v1/health'
const FAILURE_THRESHOLD = 2

/** Debounce guard: many app requests can fail in the same burst (one
 *  refetch wave hitting a stalled backend) — verify with ONE probe. */
let probePending = false

// Handles for the two deferred probes below. Kept so they can be
// CANCELLED, which they previously could not be: `reportFailure`
// scheduled a 250ms probe and, on a first failure, a further 2s one,
// and neither had an owner. In the app that is merely untidy — the
// store is a singleton and `navigator` always exists in a browser. In
// the test runner it is a fault: a file that provokes one request
// failure leaves a live timer behind, and it fires inside whichever
// file happens to be running 250ms later, or after the environment has
// been torn down, where `navigator.onLine` throws a bare
// ReferenceError that vitest reports as an unhandled error against an
// innocent test file.
let probeTimer: ReturnType<typeof setTimeout> | null = null
let followUpTimer: ReturnType<typeof setTimeout> | null = null

/** Cancel any deferred health probe. Idempotent.
 *
 *  Called from the global test teardown so no test file can leak a
 *  timer into the next one. Safe to call in the app too — the next
 *  `reportFailure` simply schedules a new probe. */
export function cancelHealthProbes(): void {
  if (probeTimer !== null) { clearTimeout(probeTimer); probeTimer = null }
  if (followUpTimer !== null) { clearTimeout(followUpTimer); followUpTimer = null }
  probePending = false
}

function classifyError(err: unknown): { reason: HealthReason; detail: string } {
  if (!navigator.onLine) {
    return { reason: 'network-offline', detail: 'Your device appears to be offline.' }
  }
  if (err instanceof TypeError) {
    const msg = err.message.toLowerCase()
    if (
      msg.includes('failed to fetch') ||
      msg.includes('networkerror') ||
      msg.includes('network request failed') ||
      msg.includes('load failed')
    ) {
      return { reason: 'backend-down', detail: 'The backend server is not responding.' }
    }
  }
  if (err instanceof Error && err.message) {
    return { reason: 'backend-down', detail: err.message }
  }
  return { reason: 'backend-down', detail: 'An unexpected error occurred.' }
}

function applyFailure(
  get: () => HealthState,
  set: (s: Partial<HealthState>) => void,
  reason: HealthReason,
  detail: string,
) {
  const failures = get().consecutiveFailures + 1
  const shouldSurface = failures >= FAILURE_THRESHOLD
    || reason === 'network-offline'
    || get().status === 'unreachable' // already showing — keep it

  if (shouldSurface) {
    set({
      status: 'unreachable',
      reason,
      detail,
      consecutiveFailures: failures,
      lastCheckedAt: Date.now(),
    })
  } else {
    set({ consecutiveFailures: failures, lastCheckedAt: Date.now() })
  }
}

export const useHealthStore = create<HealthState>()((set, get) => ({
  status: 'healthy',
  reason: 'none',
  detail: null,
  lastCheckedAt: null,
  consecutiveFailures: 0,

  poll: async () => {
    // Fast path: browser says we're offline.
    //
    // The `typeof` guard is not about browsers — every browser has a
    // navigator. It is about a deferred probe outliving the environment
    // that scheduled it, where reading `.onLine` throws a bare
    // ReferenceError with no stack pointing anywhere useful.
    // `cancelHealthProbes` is the actual fix; this is the seatbelt.
    if (typeof navigator === 'undefined') return
    if (!navigator.onLine) {
      applyFailure(get, set, 'network-offline', 'Your device appears to be offline.')
      return
    }

    try {
      // 10s (not the previous 3s): a real outage fails fast on
      // connection-refused; only a slow-but-alive backend approaches
      // the timeout, and that's exactly the false-alarm case.
      const res = await fetchWithTimeout(HEALTH_URL, { cache: 'no-store', timeoutMs: 10_000 })

      if (!res.ok) {
        applyFailure(get, set, 'backend-down', `Backend returned HTTP ${res.status}.`)
        return
      }

      // P4.6 — dropped the dead `body.status === 'unhealthy'` branch.
      // Post-P0.3, /health is an alias for /health/live which only returns
      // {status: 'live'} — the unhealthy branch was unreachable. DB-
      // unhealthy signals now flow through the per-request failure
      // path: actual DB-backed endpoints return 503 and the FE classifies
      // the failure via classifyError() in catch(err) below.
      const _body = await res.json()
      void _body
      const prevStatus = get().status

      // Healthy response
      if (prevStatus === 'unreachable') {
        set({
          status: 'recovered',
          reason: 'none',
          detail: 'Backend services are back online.',
          consecutiveFailures: 0,
          lastCheckedAt: Date.now(),
        })
      } else if (prevStatus !== 'recovered') {
        set({
          status: 'healthy',
          reason: 'none',
          detail: null,
          consecutiveFailures: 0,
          lastCheckedAt: Date.now(),
        })
      }
    } catch (err) {
      const classified = classifyError(err)
      applyFailure(get, set, classified.reason, classified.detail)
    }
  },

  reportFailure: (err: unknown) => {
    const classified = classifyError(err)
    // Browser says we're offline — surface immediately, no probe needed.
    if (classified.reason === 'network-offline') {
      applyFailure(get, set, classified.reason, classified.detail)
      return
    }
    // App-request failure: verify against /health instead of counting
    // it toward the banner threshold (see module docstring).
    if (probePending) return
    probePending = true
    probeTimer = setTimeout(() => {
      probePending = false
      probeTimer = null
      void (async () => {
        await get().poll()
        const s = get()
        // First failed verification on a quiet page: confirm or deny
        // quickly rather than waiting for the banner's next tick.
        if (s.status !== 'unreachable' && s.consecutiveFailures === 1) {
          followUpTimer = setTimeout(() => {
            followUpTimer = null
            void get().poll()
          }, 2_000)
        }
      })()
    }, 250)
  },

  clearRecovery: () => {
    set({ status: 'healthy', reason: 'none', detail: null })
  },
}))
