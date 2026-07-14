import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Check, AlertCircle, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { prefersReducedMotion } from './constants'

export function Toast({
  message,
  visible,
  onDismiss,
  variant = 'success',
  action,
}: {
  message: string
  visible: boolean
  onDismiss: () => void
  variant?: 'success' | 'error'
  /**
   * An escape hatch, offered for as long as the toast lives.
   *
   * The thing that stops people using an admin page is not difficulty, it's fear: every switch on
   * it changes what everybody can do, and a mistake is only visible to the users, not to you. A
   * visible Undo is worth more reassurance than any amount of confirmation copy, because it makes
   * the click cheap instead of merely well-explained.
   */
  action?: { label: string; onClick: () => void }
}) {
  const duration = action ? 8000 : variant === 'error' ? 4000 : 3000
  useEffect(() => {
    if (!visible) return
    const t = setTimeout(onDismiss, duration)
    return () => clearTimeout(t)
  }, [visible, onDismiss, duration])

  const reduced = prefersReducedMotion()
  const isError = variant === 'error'
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={reduced ? { opacity: 1 } : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: 10 }}
          transition={{ duration: reduced ? 0 : 0.2 }}
          className={cn(
            'fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-xl shadow-lg backdrop-blur-sm',
            isError
              ? 'bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400'
              : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400'
          )}
          role="status"
          aria-live={isError ? 'assertive' : 'polite'}
        >
          {isError ? (
            <AlertCircle className="w-5 h-5 shrink-0" />
          ) : (
            <Check className="w-5 h-5 shrink-0" />
          )}
          <span className="text-sm font-medium">{message}</span>
          {action && (
            <button
              onClick={() => {
                action.onClick()
                onDismiss()
              }}
              className="shrink-0 ml-1 px-2 py-1 rounded-lg text-xs font-semibold underline underline-offset-2 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            >
              {action.label}
            </button>
          )}
          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            className="shrink-0 rounded-md p-0.5 opacity-60 hover:opacity-100 transition-opacity hover:bg-black/5 dark:hover:bg-white/5"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
