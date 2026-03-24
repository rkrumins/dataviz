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
import { fetchWithTimeout } from '@/services/fetchWithTimeout'

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
    // Fast path: browser says we're offline
    if (!navigator.onLine) {
      applyFailure(get, set, 'network-offline', 'Your device appears to be offline.')
      return
    }

    try {
      const res = await fetchWithTimeout(HEALTH_URL, { cache: 'no-store', timeoutMs: 3_000 })

      if (!res.ok) {
        applyFailure(get, set, 'backend-down', `Backend returned HTTP ${res.status}.`)
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
      const classified = classifyError(err)
      applyFailure(get, set, classified.reason, classified.detail)
    }
  },

  reportFailure: (err: unknown) => {
    const classified = classifyError(err)
    applyFailure(get, set, classified.reason, classified.detail)
  },

  clearRecovery: () => {
    set({ status: 'healthy', reason: 'none', detail: null })
  },
}))
