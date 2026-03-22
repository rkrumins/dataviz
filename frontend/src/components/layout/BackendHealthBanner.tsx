/**
 * BackendHealthBanner — full-width banner shown when backend services are
 * unreachable, degraded, or have just recovered.
 *
 * Visually matches GlobalAnnouncementBanner. Polls /api/v1/health with
 * adaptive intervals (30s healthy, 5s unhealthy) and listens for browser
 * online/offline events.
 */
import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { WifiOff, AlertTriangle, CheckCircle, RefreshCw } from 'lucide-react'
import { useHealthStore } from '@/store/health'

const POLL_HEALTHY_MS = 30_000
const POLL_UNHEALTHY_MS = 5_000
const RECOVERY_DISMISS_MS = 5_000

const BANNER_STYLES = {
  unreachable: {
    bar: 'bg-gradient-to-r from-red-600 via-rose-600 to-red-600',
    text: 'text-white',
    muted: 'text-red-100',
    dot: 'bg-red-300',
  },
  degraded: {
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

function getBannerContent(status: string, reason: string, detail: string | null) {
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
      message: detail || 'Cannot reach the backend services. Retrying…',
      style: BANNER_STYLES.unreachable,
      spinning: true,
    }
  }
  if (status === 'degraded') {
    return {
      Icon: AlertTriangle,
      title: 'Service Degraded',
      message: detail || 'Some backend services are experiencing issues. Functionality may be limited.',
      style: BANNER_STYLES.degraded,
      spinning: false,
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

export function BackendHealthBanner() {
  const { status, reason, detail, poll, reportFailure, clearRecovery } = useHealthStore()
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Adaptive health polling
  useEffect(() => {
    poll() // immediate first check
    const ms = status === 'healthy' || status === 'recovered' ? POLL_HEALTHY_MS : POLL_UNHEALTHY_MS
    const id = setInterval(poll, ms)
    return () => clearInterval(id)
  }, [poll, status])

  // Browser online/offline events
  useEffect(() => {
    const goOffline = () => reportFailure(new TypeError('Failed to fetch'))
    const goOnline = () => { poll() }
    window.addEventListener('offline', goOffline)
    window.addEventListener('online', goOnline)
    return () => {
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('online', goOnline)
    }
  }, [reportFailure, poll])

  // Auto-dismiss recovery banner after 5s
  useEffect(() => {
    if (status === 'recovered') {
      recoveryTimer.current = setTimeout(clearRecovery, RECOVERY_DISMISS_MS)
    }
    return () => {
      if (recoveryTimer.current) {
        clearTimeout(recoveryTimer.current)
        recoveryTimer.current = null
      }
    }
  }, [status, clearRecovery])

  const visible = status === 'unreachable' || status === 'degraded' || status === 'recovered'

  if (!visible) return null

  const { Icon, title, message, style, spinning } = getBannerContent(status, reason, detail)

  return (
    <AnimatePresence initial={false}>
      <motion.div
        key={status}
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        exit={{ opacity: 0, height: 0 }}
        transition={{ type: 'spring', stiffness: 500, damping: 40 }}
        className="shrink-0 overflow-hidden"
      >
        <div className={`relative ${style.bar}`}>
          {/* Shimmer overlay */}
          <div className="absolute inset-0 bg-[linear-gradient(110deg,transparent_25%,rgba(255,255,255,0.08)_50%,transparent_75%)] bg-[length:250%_100%] animate-[shimmer_8s_ease-in-out_infinite]" />

          <div className="relative z-10 px-4 py-2.5">
            <div className="flex items-center justify-center gap-3 max-w-screen-2xl mx-auto">
              {/* Icon */}
              <span className="relative shrink-0 flex items-center justify-center">
                <Icon className={`w-4 h-4 ${style.text}`} />
                <span className={`absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ${style.dot} animate-pulse`} />
              </span>

              {/* Title + message */}
              <div className="flex items-center gap-2 flex-wrap justify-center text-center min-w-0">
                <span className={`text-sm font-bold tracking-wide ${style.text}`}>
                  {title}
                </span>
                <span className={`hidden sm:inline text-sm ${style.muted}`}>—</span>
                <span className={`text-sm font-medium ${style.muted}`}>
                  {message}
                </span>
              </div>

              {/* Spinning retry indicator */}
              {spinning && (
                <RefreshCw className={`w-3.5 h-3.5 ${style.muted} animate-spin`} />
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
