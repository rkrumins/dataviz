/**
 * AvatarPickerDialog — lets users choose from a set of pre-defined avatars.
 * Selection is persisted in the preferences store.
 */

import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePreferencesStore } from '@/store/preferences'

interface AvatarPickerDialogProps {
  isOpen: boolean
  onClose: () => void
  initials: string
}

/** Pre-defined avatar options — each is a simple SVG inline illustration. */
const AVATARS: { id: string; label: string; bg: string; content: (cls: string) => React.ReactNode }[] = [
  {
    id: 'bot',
    label: 'Robot',
    bg: 'bg-sky-500/15',
    content: (cls) => (
      <svg className={cls} viewBox="0 0 36 36" fill="none">
        <rect x="8" y="12" width="20" height="16" rx="4" stroke="currentColor" strokeWidth="2" />
        <circle cx="14" cy="20" r="2" fill="currentColor" />
        <circle cx="22" cy="20" r="2" fill="currentColor" />
        <path d="M14 25h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="18" y1="6" x2="18" y2="12" stroke="currentColor" strokeWidth="2" />
        <circle cx="18" cy="5" r="2" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'cat',
    label: 'Cat',
    bg: 'bg-amber-500/15',
    content: (cls) => (
      <svg className={cls} viewBox="0 0 36 36" fill="none">
        <path d="M8 28V14l5-8h10l5 8v14a2 2 0 01-2 2H10a2 2 0 01-2-2z" stroke="currentColor" strokeWidth="2" />
        <circle cx="14" cy="18" r="2" fill="currentColor" />
        <circle cx="22" cy="18" r="2" fill="currentColor" />
        <path d="M16 23l2 2 2-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12 24h-4M24 24h4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'rocket',
    label: 'Rocket',
    bg: 'bg-rose-500/15',
    content: (cls) => (
      <svg className={cls} viewBox="0 0 36 36" fill="none">
        <path d="M18 4c-4 6-6 12-6 18h12c0-6-2-12-6-18z" stroke="currentColor" strokeWidth="2" />
        <circle cx="18" cy="16" r="3" stroke="currentColor" strokeWidth="1.5" />
        <path d="M12 22l-4 6h4M24 22l4 6h-4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M15 28h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'tree',
    label: 'Tree',
    bg: 'bg-emerald-500/15',
    content: (cls) => (
      <svg className={cls} viewBox="0 0 36 36" fill="none">
        <path d="M18 4l-8 12h4l-5 8h18l-5-8h4L18 4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <rect x="16" y="24" width="4" height="8" rx="1" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    id: 'star',
    label: 'Star',
    bg: 'bg-yellow-500/15',
    content: (cls) => (
      <svg className={cls} viewBox="0 0 36 36" fill="none">
        <path d="M18 4l4.09 8.29L31 13.64l-6.5 6.33 1.53 8.96L18 24.77l-8.03 4.16 1.53-8.96L5 13.64l8.91-1.35L18 4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'mountain',
    label: 'Mountain',
    bg: 'bg-violet-500/15',
    content: (cls) => (
      <svg className={cls} viewBox="0 0 36 36" fill="none">
        <path d="M4 30l10-18 4 6 6-12 8 24H4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <circle cx="28" cy="8" r="3" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    id: 'diamond',
    label: 'Diamond',
    bg: 'bg-cyan-500/15',
    content: (cls) => (
      <svg className={cls} viewBox="0 0 36 36" fill="none">
        <path d="M18 4l14 14-14 14L4 18 18 4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M10 18h16M18 10v16" stroke="currentColor" strokeWidth="1" opacity="0.4" />
      </svg>
    ),
  },
  {
    id: 'lightning',
    label: 'Lightning',
    bg: 'bg-orange-500/15',
    content: (cls) => (
      <svg className={cls} viewBox="0 0 36 36" fill="none">
        <path d="M20 4L10 20h7l-3 12 13-18h-8L20 4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      </svg>
    ),
  },
]

export function AvatarPickerDialog({ isOpen, onClose, initials }: AvatarPickerDialogProps) {
  const avatarId = usePreferencesStore((s) => s.avatarId)
  const setAvatarId = usePreferencesStore((s) => s.setAvatarId)
  const [selected, setSelected] = useState<string | null>(avatarId)

  useEffect(() => {
    if (isOpen) setSelected(avatarId)
  }, [isOpen, avatarId])

  const handleSave = useCallback(() => {
    setAvatarId(selected)
    onClose()
  }, [selected, setAvatarId, onClose])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose],
  )

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onKeyDown={handleKeyDown}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/40" onClick={onClose} />

          {/* Panel */}
          <motion.div
            className={cn(
              'relative w-full max-w-sm mx-4 rounded-2xl shadow-lg',
              'bg-canvas-elevated border border-glass-border',
              'p-5',
            )}
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ duration: 0.15 }}
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-ink">Choose Avatar</h2>
              <button
                onClick={onClose}
                className="p-1 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Initials (default) option */}
            <button
              onClick={() => setSelected(null)}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 rounded-xl mb-3 transition-colors duration-100',
                selected === null
                  ? 'bg-accent-lineage/10 ring-2 ring-accent-lineage/40'
                  : 'hover:bg-black/5 dark:hover:bg-white/5',
              )}
            >
              <div className="w-10 h-10 rounded-full bg-accent-lineage/15 flex items-center justify-center shrink-0">
                <span className="text-sm font-semibold text-accent-lineage select-none">{initials}</span>
              </div>
              <span className="text-sm text-ink">Use my initials</span>
              {selected === null && <Check className="w-4 h-4 ml-auto text-accent-lineage" />}
            </button>

            {/* Avatar grid */}
            <div className="grid grid-cols-4 gap-2">
              {AVATARS.map((av) => (
                <button
                  key={av.id}
                  onClick={() => setSelected(av.id)}
                  className={cn(
                    'flex flex-col items-center gap-1.5 p-2 rounded-xl transition-colors duration-100',
                    selected === av.id
                      ? 'bg-accent-lineage/10 ring-2 ring-accent-lineage/40'
                      : 'hover:bg-black/5 dark:hover:bg-white/5',
                  )}
                  title={av.label}
                >
                  <div
                    className={cn(
                      'w-10 h-10 rounded-full flex items-center justify-center',
                      av.bg,
                    )}
                  >
                    {av.content('w-6 h-6 text-ink')}
                  </div>
                  <span className="text-[10px] text-ink-muted leading-none">{av.label}</span>
                </button>
              ))}
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-glass-border">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-sm text-ink-secondary rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                className={cn(
                  'px-4 py-1.5 text-sm font-medium rounded-lg transition-colors',
                  'bg-accent-lineage text-white hover:bg-accent-lineage/90',
                )}
              >
                Save
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Render the chosen avatar inline — returns SVG content or null (caller renders initials). */
export function useAvatarContent() {
  const avatarId = usePreferencesStore((s) => s.avatarId)
  const avatar = avatarId ? AVATARS.find((a) => a.id === avatarId) : null
  return avatar ?? null
}
