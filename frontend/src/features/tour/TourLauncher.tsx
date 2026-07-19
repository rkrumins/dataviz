import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, X, ArrowRight } from 'lucide-react'
import { useTourStore } from './tourStore'
import { getTour, FIRST_RUN_TOUR } from './tours'

const DISMISS_KEY = 'nx-tour-offer-dismissed'

/**
 * First-run nudge: a small, dismissible card offering the getting-started tour.
 * Shows once for a new user — hidden after they take it, dismiss it, or once a
 * tour is already running. Mounted (and thus gated) behind the tours feature
 * flag by the shell.
 */
export function TourLauncher() {
  const activeTourId = useTourStore((s) => s.activeTourId)
  const completed = useTourStore((s) => s.completed)
  const start = useTourStore((s) => s.start)
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1'
    } catch {
      return false
    }
  })

  const tour = getTour(FIRST_RUN_TOUR)
  const alreadyDone = completed.includes(FIRST_RUN_TOUR)
  const show = !!tour && !activeTourId && !alreadyDone && !dismissed

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* private mode — will offer again next session */
    }
    setDismissed(true)
  }

  return (
    <AnimatePresence>
      {show && tour && (
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 24, scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          className="glass-panel fixed bottom-5 right-5 z-[150] w-80 max-w-[calc(100vw-2.5rem)] rounded-2xl border border-glass-border p-4 shadow-2xl"
          role="dialog"
          aria-label="Take a product tour"
        >
          <button
            onClick={dismiss}
            aria-label="Dismiss"
            className="absolute right-2 top-2 rounded-lg p-1 text-ink-muted transition-colors hover:bg-black/5 hover:text-ink dark:hover:bg-white/5"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/20">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="min-w-0 pr-4">
              <h3 className="text-sm font-bold text-ink">New here? Take a quick tour</h3>
              <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
                Get the lay of the workspace in about {tour.estimate}.
              </p>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button onClick={dismiss} className="btn btn-ghost btn-sm">
              Not now
            </button>
            <button onClick={() => start(FIRST_RUN_TOUR)} className="btn btn-primary btn-sm">
              Start tour <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
