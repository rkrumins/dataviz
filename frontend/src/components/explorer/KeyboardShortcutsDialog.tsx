/**
 * KeyboardShortcutsDialog — cheat-sheet modal for the Explorer.
 *
 * Surfaces the shortcuts the page already ships with (``/``, ``?``,
 * arrows, ``Enter``, ``f``, ``Esc``) plus a Command Palette slot
 * reserved for the future ⌘K feature. Undiscoverable shortcuts are
 * nearly worthless; this makes them one keystroke away.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { createPortal } from 'react-dom'
import { Command, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useEffect } from 'react'

interface Shortcut {
  keys: string[]
  label: string
  /** Subtle hint shown under the label for context. */
  hint?: string
}

const NAV_SHORTCUTS: Shortcut[] = [
  { keys: ['/'], label: 'Focus search', hint: 'From anywhere on the page' },
  { keys: ['?'], label: 'Show this help' },
  { keys: ['Esc'], label: 'Clear search / close overlay' },
]

const GRID_SHORTCUTS: Shortcut[] = [
  { keys: ['↑', '↓', '←', '→'], label: 'Navigate between views' },
  { keys: ['Enter'], label: 'Preview the focused view' },
  { keys: ['f'], label: 'Toggle favorite on the focused view' },
]

interface KeyboardShortcutsDialogProps {
  isOpen: boolean
  onClose: () => void
}

export function KeyboardShortcutsDialog({ isOpen, onClose }: KeyboardShortcutsDialogProps) {
  // Esc dismissal. Stops at the document listener so it fires
  // regardless of focus position.
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-black/50"
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-label="Keyboard shortcuts"
        >
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className={cn(
              'w-full max-w-lg rounded-2xl border border-glass-border bg-canvas-elevated shadow-lg',
              'overflow-hidden',
            )}
            onClick={e => e.stopPropagation()}
          >
            {/* ── Header ── */}
            <div className="flex items-center gap-3 px-5 py-4 border-b border-glass-border/60">
              <div className="w-8 h-8 rounded-lg bg-accent-lineage/10 border border-accent-lineage/20 flex items-center justify-center">
                <Command className="w-4 h-4 text-accent-lineage" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-sm font-bold text-ink">Keyboard shortcuts</h2>
                <p className="text-[11px] text-ink-muted">
                  Press <Kbd>?</Kbd> anywhere to open this again
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg p-1.5 text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* ── Sections ── */}
            <div className="px-5 py-4 grid gap-5 sm:grid-cols-2">
              <ShortcutSection title="Navigation" items={NAV_SHORTCUTS} />
              <ShortcutSection title="Grid & cards" items={GRID_SHORTCUTS} />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function ShortcutSection({ title, items }: { title: string; items: Shortcut[] }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-bold text-ink-muted mb-2">
        {title}
      </div>
      <ul className="space-y-2">
        {items.map(item => (
          <li key={item.label} className="flex items-center gap-3">
            <div className="flex items-center gap-1 shrink-0">
              {item.keys.map((k, i) => (
                <Kbd key={i}>{k}</Kbd>
              ))}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-ink truncate">{item.label}</div>
              {item.hint && (
                <div className="text-[10px] text-ink-muted/70 truncate">{item.hint}</div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded border border-glass-border bg-black/[0.03] dark:bg-white/[0.04] text-[10px] font-mono font-semibold text-ink">
      {children}
    </kbd>
  )
}
