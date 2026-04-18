/**
 * BackendHealthBanner — full-width banner shown when backend services are
 * unreachable or have just recovered. Provider outages are shown separately.
 *
 * Visually matches GlobalAnnouncementBanner. Polls /api/v1/health with
 * adaptive intervals and listens for browser online/offline events.
 *
 * Features:
 * - Adaptive polling: 30s healthy, exponential backoff when unhealthy (5→10→20→30s cap)
 * - Tab visibility: pauses polling when tab is hidden, resumes on focus
 * - Browser online/offline listeners for instant detection
 * - Accessible: role="alert" + aria-live for screen reader announcements
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { WifiOff, AlertTriangle, CheckCircle, RefreshCw, X } from 'lucide-react'
import { useHealthStore, type HealthStatus, type HealthReason } from '@/store/health'
import { useAllProviderStatuses } from '@/store/providerStatus'

const POLL_HEALTHY_MS = 30_000
const POLL_UNHEALTHY_BASE_MS = 5_000
const POLL_UNHEALTHY_CAP_MS = 30_000
const RECOVERY_DISMISS_MS = 5_000

const BANNER_STYLES = {
  unreachable: {
    bar: 'bg-gradient-to-r from-red-600 via-rose-600 to-red-600',
    text: 'text-white',
    muted: 'text-red-100',
    dot: 'bg-red-300',
  },
  warning: {
    bar: 'bg-gradient-to-r from-amber-500 via-orange-500 to-amber-500',
    text: 'text-white',
    muted: 'text-amber-100',
    dot: 'bg-amber-200',
  },
  recovered: {
    bar: 'bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-600',
    text: 'text-white',
    muted: 'text-emerald-100',
    dot: 'bg-emerald-300',
  },
} as const

function getBannerContent(status: HealthStatus, reason: HealthReason, detail: string | null) {
  if (status === 'unreachable' && reason === 'network-offline') {
    return {
      Icon: WifiOff,
      title: "You're Offline",
      message: 'Check your internet connection. We\'ll reconnect automatically.',
      style: BANNER_STYLES.unreachable,
      spinning: false,
    }
  }
  if (status === 'unreachable') {
    return {
      Icon: AlertTriangle,
      title: 'Service Unavailable',
      message: detail || 'Cannot reach the backend services. Retrying\u2026',
      style: BANNER_STYLES.unreachable,
      spinning: true,
    }
  }
  // recovered
  return {
    Icon: CheckCircle,
    title: 'Connection Restored',
    message: 'Backend services are back online.',
    style: BANNER_STYLES.recovered,
    spinning: false,
  }
}

/** Exponential backoff: 5s → 10s → 20s → 30s cap */
function getUnhealthyInterval(consecutiveFailures: number): number {
  const backoff = POLL_UNHEALTHY_BASE_MS * Math.pow(2, Math.max(0, consecutiveFailures - 2))
  return Math.min(backoff, POLL_UNHEALTHY_CAP_MS)
}

export function BackendHealthBanner() {
  const status = useHealthStore((s) => s.status)
  const reason = useHealthStore((s) => s.reason)
  const detail = useHealthStore((s) => s.detail)
  const providerStatuses = useAllProviderStatuses()

  const [tabVisible, setTabVisible] = useState(() => document.visibilityState === 'visible')
  const [providerBannerDismissed, setProviderBannerDismissed] = useState(false)

  // Use refs for store actions to avoid re-triggering effects
  const pollRef = useRef(useHealthStore.getState().poll)
  const reportFailureRef = useRef(useHealthStore.getState().reportFailure)
  const clearRecoveryRef = useRef(useHealthStore.getState().clearRecovery)

  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Stable poll callback
  const doPoll = useCallback(() => pollRef.current(), [])

  // Track tab visibility
  useEffect(() => {
    const onVisibilityChange = () => setTabVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [])

  // Adaptive health polling with self-adjusting setTimeout chain.
  // Dependencies are only `tabVisible` and `status` — NOT consecutiveFailures,
  // which would cause a re-render → re-run → immediate poll loop.
  // Backoff is read from the store imperatively inside each scheduled callback.
  useEffect(() => {
    if (!tabVisible) return // don't poll background tabs

    let cancelled = false

    const scheduleNext = async () => {
      if (cancelled) return

      await doPoll()
      if (cancelled) return

      // Read fresh state AFTER the poll to pick the right interval
      const { status: currentStatus, consecutiveFailures: failures } = useHealthStore.getState()
      const isHealthy = currentStatus === 'healthy' || currentStatus === 'recovered'
      const ms = isHealthy ? POLL_HEALTHY_MS : getUnhealthyInterval(failures)

      intervalRef.current = setTimeout(scheduleNext, ms)
    }

    // If the health store already has data from AuthBootstrap's startup
    // check, skip the immediate poll and go straight to scheduling the
    // next cycle. This eliminates the duplicate initial health check.
    const { lastCheckedAt } = useHealthStore.getState()
    if (lastCheckedAt && Date.now() - lastCheckedAt < POLL_HEALTHY_MS) {
      const { status: currentStatus, consecutiveFailures: failures } = useHealthStore.getState()
      const isHealthy = currentStatus === 'healthy' || currentStatus === 'recovered'
      const ms = isHealthy ? POLL_HEALTHY_MS : getUnhealthyInterval(failures)
      intervalRef.current = setTimeout(scheduleNext, ms)
    } else {
      scheduleNext()
    }

    return () => {
      cancelled = true
      if (intervalRef.current) {
        clearTimeout(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [doPoll, status, tabVisible])

  // Browser online/offline events
  useEffect(() => {
    const goOffline = () => reportFailureRef.current(new TypeError('Failed to fetch'))
    const goOnline = () => doPoll()
    window.addEventListener('offline', goOffline)
    window.addEventListener('online', goOnline)
    return () => {
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('online', goOnline)
    }
  }, [doPoll])

  // Auto-dismiss recovery banner after 5s
  useEffect(() => {
    if (status === 'recovered') {
      recoveryTimer.current = setTimeout(() => clearRecoveryRef.current(), RECOVERY_DISMISS_MS)
    }
    return () => {
      if (recoveryTimer.current) {
        clearTimeout(recoveryTimer.current)
        recoveryTimer.current = null
      }
    }
  }, [status])

  const unavailableProviders = useMemo(
    () => providerStatuses.filter((status) => status.status === 'unavailable'),
    [providerStatuses],
  )
  const providerBannerKey = unavailableProviders.map((status) => status.id).sort().join(':')

  useEffect(() => {
    setProviderBannerDismissed(false)
  }, [providerBannerKey])

  const visible = status === 'unreachable' || status === 'recovered'

  const content = visible ? getBannerContent(status, reason, detail) : null
  const providerContent = unavailableProviders.length > 0 && !providerBannerDismissed
    ? {
        Icon: AlertTriangle,
        title: unavailableProviders.length === 1
          ? 'Provider Unavailable'
          : `${unavailableProviders.length} Providers Unavailable`,
        message: unavailableProviders
          .map((provider) => provider.name)
          .join(', ') + ' may affect graph features that depend on them.',
        style: BANNER_STYLES.warning,
      }
    : null

  return (
    <>
      <AnimatePresence initial={false}>
        {content && (
          <motion.div
            key={status}
            role="alert"
            aria-live="assertive"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 40 }}
            className="shrink-0 overflow-hidden"
          >
            <div className={`relative ${content.style.bar}`}>
              <div className="absolute inset-0 bg-[linear-gradient(110deg,transparent_25%,rgba(255,255,255,0.08)_50%,transparent_75%)] bg-[length:250%_100%] animate-[shimmer_8s_ease-in-out_infinite]" />

              <div className="relative z-10 px-4 py-2.5">
                <div className="flex items-center justify-center gap-3 max-w-screen-2xl mx-auto">
                  <span className="relative shrink-0 flex items-center justify-center">
                    <content.Icon className={`w-4 h-4 ${content.style.text}`} />
                    <span className={`absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ${content.style.dot} animate-pulse`} />
                  </span>

                  <div className="flex items-center gap-2 flex-wrap justify-center text-center min-w-0">
                    <span className={`text-sm font-bold tracking-wide ${content.style.text}`}>
                      {content.title}
                    </span>
                    <span className={`hidden sm:inline text-sm ${content.style.muted}`}>-</span>
                    <span className={`text-sm font-medium ${content.style.muted}`}>
                      {content.message}
                    </span>
                  </div>

                  {content.spinning && (
                    <RefreshCw className={`w-3.5 h-3.5 ${content.style.muted} animate-spin`} />
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {providerContent && (
          <motion.div
            key={providerBannerKey}
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 40 }}
            className="shrink-0 overflow-hidden"
          >
            <div className={`relative ${providerContent.style.bar}`}>
              <div className="relative z-10 px-4 py-2.5">
                <div className="flex items-center justify-center gap-3 max-w-screen-2xl mx-auto">
                  <span className="relative shrink-0 flex items-center justify-center">
                    <providerContent.Icon className={`w-4 h-4 ${providerContent.style.text}`} />
                    <span className={`absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ${providerContent.style.dot} animate-pulse`} />
                  </span>

                  <div className="flex items-center gap-2 flex-wrap justify-center text-center min-w-0">
                    <span className={`text-sm font-bold tracking-wide ${providerContent.style.text}`}>
                      {providerContent.title}
                    </span>
                    <span className={`hidden sm:inline text-sm ${providerContent.style.muted}`}>-</span>
                    <span className={`text-sm font-medium ${providerContent.style.muted}`}>
                      {providerContent.message}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => setProviderBannerDismissed(true)}
                    className={`inline-flex items-center justify-center rounded-md border border-white/20 bg-white/10 p-1 transition hover:bg-white/20 ${providerContent.style.text}`}
                    aria-label="Dismiss provider status banner"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
