/**
 * Backend health monitoring store.
 *
 * Polls /api/v1/health periodically and accepts failure reports from authFetch.
 * Drives the BackendHealthBanner with four states:
 *   healthy → degraded → unreachable → recovered → healthy
 *
 * Anti-flapping: requires 2 consecutive failures before surfacing the banner.
 * Adaptive polling: 30s when healthy, 5s when unhealthy.
 */
import { create } from 'zustand'

export type HealthStatus = 'healthy' | 'degraded' | 'unreachable' | 'recovered'
export type HealthReason = 'none' | 'network-offline' | 'backend-down' | 'backend-degraded'

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

/** Guard against overlapping poll() calls. */
let _polling = false

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

export const useHealthStore = create<HealthState>()((set, get) => ({
  status: 'healthy',
  reason: 'none',
  detail: null,
  lastCheckedAt: null,
  consecutiveFailures: 0,

  poll: async () => {
    if (_polling) return
    _polling = true

    try {
      // Fast path: browser says we're offline
      if (!navigator.onLine) {
        const failures = get().consecutiveFailures + 1
        if (failures >= FAILURE_THRESHOLD || get().status === 'unreachable') {
          set({
            status: 'unreachable',
            reason: 'network-offline',
            detail: 'Your device appears to be offline.',
            consecutiveFailures: failures,
            lastCheckedAt: Date.now(),
          })
        } else {
          set({ consecutiveFailures: failures, lastCheckedAt: Date.now() })
        }
        return
      }

      const res = await fetch(HEALTH_URL, { cache: 'no-store' })

      if (!res.ok) {
        // Health endpoint returned an error status (5xx, etc.)
        const failures = get().consecutiveFailures + 1
        if (failures >= FAILURE_THRESHOLD) {
          set({
            status: 'unreachable',
            reason: 'backend-down',
            detail: `Backend returned HTTP ${res.status}.`,
            consecutiveFailures: failures,
            lastCheckedAt: Date.now(),
          })
        } else {
          set({ consecutiveFailures: failures, lastCheckedAt: Date.now() })
        }
        return
      }

      const body = await res.json()
      const prevStatus = get().status

      if (body.status === 'degraded') {
        // Parse dependency details for a helpful message
        let detail = 'Some backend services are experiencing issues.'
        const deps = body.dependencies
        if (deps) {
          const unhealthy: string[] = []
          for (const [name, val] of Object.entries(deps)) {
            const s = typeof val === 'string' ? val : (val as any)?.status ?? ''
            if (String(s).startsWith('unhealthy')) unhealthy.push(name)
          }
          if (unhealthy.length > 0) {
            detail = `Degraded: ${unhealthy.join(', ')} ${unhealthy.length === 1 ? 'is' : 'are'} unhealthy.`
          }
        }
        set({
          status: 'degraded',
          reason: 'backend-degraded',
          detail,
          consecutiveFailures: 0,
          lastCheckedAt: Date.now(),
        })
      } else {
        // Healthy response
        if (prevStatus === 'unreachable' || prevStatus === 'degraded') {
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
      }
    } catch (err) {
      const failures = get().consecutiveFailures + 1
      const classified = classifyError(err)

      if (failures >= FAILURE_THRESHOLD) {
        set({
          status: 'unreachable',
          reason: classified.reason,
          detail: classified.detail,
          consecutiveFailures: failures,
          lastCheckedAt: Date.now(),
        })
      } else {
        set({ consecutiveFailures: failures, lastCheckedAt: Date.now() })
      }
    } finally {
      _polling = false
    }
  },

  reportFailure: (err: unknown) => {
    const classified = classifyError(err)
    const failures = get().consecutiveFailures + 1

    // Immediate for offline, threshold for other failures
    if (classified.reason === 'network-offline' || failures >= FAILURE_THRESHOLD) {
      set({
        status: 'unreachable',
        reason: classified.reason,
        detail: classified.detail,
        consecutiveFailures: failures,
      })
    } else {
      set({ consecutiveFailures: failures })
    }
  },

  clearRecovery: () => {
    set({ status: 'healthy', reason: 'none', detail: null })
  },
}))
