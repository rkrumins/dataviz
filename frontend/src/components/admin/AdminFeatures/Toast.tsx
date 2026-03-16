import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Check, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { prefersReducedMotion } from './constants'

export function Toast({
  message,
  visible,
  onDismiss,
  variant = 'success',
}: {
  message: string
  visible: boolean
  onDismiss: () => void
  variant?: 'success' | 'error'
}) {
  const duration = variant === 'error' ? 4000 : 3000
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
        </motion.div>
      )}
    </AnimatePresence>
  )
}
