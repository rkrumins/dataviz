/**
 * One chip per active filter, each with its own ×, and "Clear all".
 *
 * Lifted out of the Explorer's filter bar so the workspace Views tab shows the
 * same chips, and driven by the dimension registry so every filter — the new
 * date, people and versioned ones included — is named and removed the same way.
 * The container eases its height; each chip springs in and out on its own, which
 * is what makes adding and removing filters feel tactile rather than jumpy.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { UserAvatar } from '@/components/ui/UserAvatar'
import type { FilterChip } from '../dimensions'
import { ME } from '../model'

export function ActiveFilterChips({ chips, onRemove, onClearAll, currentUserId, className }: {
  chips: FilterChip[]
  onRemove: (chip: FilterChip) => void
  onClearAll: () => void
  /** Lets a "You" chip show your own avatar. */
  currentUserId?: string | null
  className?: string
}) {
  return (
    <AnimatePresence>
      {chips.length > 0 && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className={cn('overflow-hidden', className)}
        >
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5 pb-0.5">
            <AnimatePresence initial={false}>
              {chips.map(chip => (
                <motion.span
                  key={chip.key}
                  layout
                  initial={{ opacity: 0, scale: 0.7, y: -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.7, y: -4 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 28, mass: 0.6 }}
                  className="inline-flex items-center gap-1.5 rounded-full border border-glass-border bg-canvas-elevated pl-2.5 pr-1 py-1 text-[11px]"
                >
                  <span className="text-ink-muted font-medium">{chip.prefix}:</span>
                  {chip.personId && (
                    <UserAvatar
                      userId={chip.personId === ME ? currentUserId : chip.personId}
                      name={chip.personName ?? chip.value}
                      shape="palette"
                      className="h-4 w-4 text-[7px] font-bold"
                    />
                  )}
                  <span className="font-semibold text-ink">{chip.value}</span>
                  <button
                    type="button"
                    onClick={() => onRemove(chip)}
                    className="rounded-full p-0.5 text-ink-muted hover:text-ink hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-150"
                    title="Remove filter"
                    aria-label={`Remove ${chip.prefix} ${chip.value}`}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </motion.span>
              ))}
            </AnimatePresence>
            <button
              type="button"
              onClick={onClearAll}
              className="text-[11px] font-medium text-ink-muted hover:text-ink transition-colors duration-150 underline underline-offset-2"
            >
              Clear all
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
