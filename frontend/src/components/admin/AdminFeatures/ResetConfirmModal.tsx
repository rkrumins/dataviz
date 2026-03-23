import { useEffect, type RefObject } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, RotateCcw } from 'lucide-react'
import { prefersReducedMotion } from './constants'

export function EffectFocusCancel({ cancelRef }: { cancelRef: RefObject<HTMLButtonElement | null> }) {
  useEffect(() => {
    cancelRef.current?.focus()
  }, [cancelRef])
  return null
}

export function ResetConfirmModal({
  open,
  onClose,
  onConfirm,
  loading,
  modalRef,
  cancelRef,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  loading: boolean
  modalRef: RefObject<HTMLDivElement | null>
  cancelRef: RefObject<HTMLButtonElement | null>
}) {
  const reduced = prefersReducedMotion()
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.15 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
          onClick={() => !loading && onClose()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="reset-dialog-title"
        >
          <motion.div
            ref={modalRef}
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.96, opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.2 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl bg-canvas-elevated border border-glass-border shadow-xl p-6"
            onKeyDown={(e) => {
              if (e.key === 'Tab') {
                const el = modalRef.current
                if (!el) return
                const focusable = el.querySelectorAll<HTMLElement>(
                  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
                )
                const first = focusable[0]
                const last = focusable[focusable.length - 1]
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault()
                  last?.focus()
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault()
                  first?.focus()
                }
              }
              if (e.key === 'Enter' && document.activeElement?.getAttribute('data-reset-confirm') === 'true') {
                e.preventDefault()
                onConfirm()
              }
            }}
          >
            <h3 id="reset-dialog-title" className="text-lg font-bold text-ink mb-2">
              Reset to defaults
            </h3>
            <p className="text-sm text-ink-muted mb-6 leading-relaxed">
              Reset all features to their default values? This cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                ref={cancelRef}
                type="button"
                onClick={onClose}
                disabled={loading}
                className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                data-reset-confirm="true"
                onClick={onConfirm}
                disabled={loading}
                className="px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50 transition-colors flex items-center gap-2"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RotateCcw className="w-4 h-4" />
                )}
                Reset
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
