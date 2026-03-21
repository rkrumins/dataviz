import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Toast, ToastType } from '../lib/ontology-types'

const DURATION = 4500

const accentColors: Record<ToastType, string> = {
  success: 'bg-emerald-500',
  error: 'bg-red-500',
  warning: 'bg-amber-500',
  info: 'bg-blue-500',
}

const iconColors: Record<ToastType, string> = {
  success: 'text-emerald-500',
  error: 'text-red-500',
  warning: 'text-amber-500',
  info: 'text-blue-500',
}

const icons: Record<ToastType, React.ComponentType<{ className?: string }>> = {
  success: CheckCircle2,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
}

export function ToastNotification({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [progress, setProgress] = useState(100)

  useEffect(() => {
    const timer = setTimeout(onDismiss, DURATION)

    const start = Date.now()
    const interval = setInterval(() => {
      const elapsed = Date.now() - start
      const remaining = Math.max(0, 100 - (elapsed / DURATION) * 100)
      setProgress(remaining)
      if (remaining <= 0) clearInterval(interval)
    }, 30)

    return () => {
      clearTimeout(timer)
      clearInterval(interval)
    }
  }, [onDismiss])

  const Icon = icons[toast.type]

  return (
    <motion.div
      initial={{ opacity: 0, y: 24, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 12, scale: 0.95 }}
      transition={{ type: 'spring', damping: 20, stiffness: 300 }}
      className={cn(
        'fixed bottom-6 right-6 z-50 w-80 max-w-sm rounded-xl overflow-hidden',
        'backdrop-blur-xl bg-canvas-elevated/90 dark:bg-canvas-elevated/95',
        'border border-glass-border shadow-2xl shadow-black/10 dark:shadow-black/30',
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3.5">
        <Icon className={cn('w-4.5 h-4.5 flex-shrink-0', iconColors[toast.type])} />
        <span className="flex-1 text-sm text-ink leading-snug">{toast.message}</span>
        {toast.action && (
          <button
            onClick={() => { toast.action!.onClick(); onDismiss() }}
            className="flex-shrink-0 px-2.5 py-1 rounded-lg text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-colors"
          >
            {toast.action.label}
          </button>
        )}
        <button
          onClick={onDismiss}
          className="opacity-40 hover:opacity-100 transition-opacity flex-shrink-0 rounded-md p-0.5 hover:bg-black/5 dark:hover:bg-white/5"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Progress bar */}
      <div className="h-0.5 w-full bg-black/5 dark:bg-white/5">
        <div
          className={cn('h-full transition-none rounded-r-full', accentColors[toast.type])}
          style={{ width: `${progress}%`, opacity: 0.6 }}
        />
      </div>
    </motion.div>
  )
}
