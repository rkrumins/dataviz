/**
 * ContinueAddingPill — while the entity builder stands aside for an entity's details (clicked while
 * adding), the way back: Continue adding where it was, Add inside the entity on show (when it can
 * hold children), or Done. How many were added this session rides along. Portaled to the body and
 * fixed there, so no blurred or transformed ancestor traps it; no exit animation, so nothing of it can
 * be left behind.
 */
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { CornerDownRight, Plus, X } from 'lucide-react'
import { HoverTip } from '@/components/ui/HoverTip'

export function ContinueAddingPill({ added, insideName, onContinue, onAddInside, onDone }: {
  /** Entities added this session. */
  added: number
  /** The entity on show, when things can be added inside it. */
  insideName: string | null
  onContinue: () => void
  onAddInside?: () => void
  onDone: () => void
}) {
  // Centred by the wrapper: framer-motion writes its own `transform` for the rise, which would
  // override a translate on the same element.
  return createPortal(
    <div className="fixed bottom-6 inset-x-0 z-40 flex justify-center px-4 pointer-events-none">
    <motion.div role="group" aria-label="Adding entities"
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      className="pointer-events-auto flex items-center gap-1 p-1 rounded-2xl border border-glass-border bg-canvas-elevated shadow-xl whitespace-nowrap max-w-full">
      <button type="button" onClick={onContinue}
        className="inline-flex items-center gap-1.5 h-9 pl-3 pr-3.5 rounded-xl text-[13px] font-semibold text-white bg-green-600 hover:bg-green-700 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500/50">
        <Plus className="w-4 h-4" aria-hidden />Continue adding
        {added > 0 && <span className="ml-0.5 px-1.5 rounded-md bg-white/20 text-[11px] tabular-nums">{added.toLocaleString()} new</span>}
      </button>
      {insideName && onAddInside && (
        <button type="button" onClick={onAddInside}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-xl text-[13px] font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] max-w-[220px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
          <CornerDownRight className="w-4 h-4 shrink-0" aria-hidden /><span className="truncate">Add inside {insideName}</span>
        </button>
      )}
      <HoverTip label="Done adding" detail="What you added stays staged" className="inline-flex">
        <button type="button" onClick={onDone} aria-label="Done adding"
          className="w-9 h-9 rounded-xl flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
          <X className="w-4 h-4" />
        </button>
      </HoverTip>
    </motion.div>
    </div>,
    document.body,
  )
}
