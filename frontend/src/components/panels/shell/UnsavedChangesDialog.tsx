/**
 * UnsavedChangesDialog — asked when a move would leave a drawer's unstaged edits behind.
 *
 * Three answers, the safe one first: stage the edits and go on (they wait in Review & Save),
 * discard them and go on, or stay. An alert dialog: focus is trapped inside it and Esc means
 * "keep editing" — never "discard".
 */
import { useId, type ReactNode } from 'react'
import { AlertTriangle, Check, Trash2 } from 'lucide-react'
import { motion } from 'framer-motion'
import { useModalA11y } from '@/hooks/useModalA11y'
import { Button } from '@/components/ui/Button'

export function UnsavedChangesDialog({ what, onStage, onDiscard, onKeep }: {
  /** What would be lost, e.g. "your changes to Orders". */
  what: ReactNode
  /** Offered when the edit can be staged as it is. */
  onStage?: () => void
  onDiscard: () => void
  onKeep: () => void
}) {
  const ref = useModalA11y(true, onKeep)
  const titleId = useId()
  const bodyId = useId()
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center p-6 bg-black/40 backdrop-blur-[2px]">
      <motion.div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        initial={{ opacity: 0, scale: 0.96, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.14, ease: 'easeOut' }}
        className="w-full max-w-sm rounded-2xl border border-glass-border bg-canvas-elevated shadow-2xl p-5 outline-none"
      >
        <div className="flex items-start gap-3">
          <span className="flex items-center justify-center w-9 h-9 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400 flex-shrink-0">
            <AlertTriangle className="w-[18px] h-[18px]" aria-hidden />
          </span>
          <div className="min-w-0">
            <h4 id={titleId} className="text-sm font-semibold text-ink">Unsaved changes</h4>
            <p id={bodyId} className="text-xs text-ink-muted mt-1 leading-relaxed">
              You haven’t staged {what} yet. Stage them to keep them for Review &amp; Save, or discard them.
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2 mt-5">
          {onStage && (
            <Button variant="primary" leftIcon={Check} onClick={onStage} className="w-full">Stage and continue</Button>
          )}
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onKeep} className="flex-1">Keep editing</Button>
            <Button variant="ghost" leftIcon={Trash2} onClick={onDiscard}
              className="flex-1 text-rose-600 dark:text-rose-400 hover:text-rose-700 dark:hover:text-rose-300 hover:bg-rose-500/10">
              Discard
            </Button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}
