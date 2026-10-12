/**
 * AvatarPickerDialog — lets users choose from a set of pre-defined avatars.
 * Selection is persisted in the preferences store.
 */

import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import { usePreferencesStore } from '@/store/preferences'
import { AVATARS } from '@/components/layout/avatarIllustrations'

interface AvatarPickerDialogProps {
  isOpen: boolean
  onClose: () => void
  initials: string
}


export function AvatarPickerDialog({ isOpen, onClose, initials }: AvatarPickerDialogProps) {
  const avatarId = usePreferencesStore((s) => s.avatarId)
  const setAvatarId = usePreferencesStore((s) => s.setAvatarId)
  const [selected, setSelected] = useState<string | null>(avatarId)
  // Provider-managed avatar: the picker still opens (so the state is
  // explained where the person looked for it) but nothing can be saved
  // — the server would 409 the write, and the provider re-applies its
  // picture at every sign-in anyway.
  const [locked, setLocked] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    setSelected(avatarId)
    let cancelled = false
    void (async () => {
      try {
        const { accountService } = await import('@/services/accountService')
        const profile = await accountService.getProfile()
        if (!cancelled) {
          setLocked((profile.idpManagedFields ?? []).includes('avatar'))
        }
      } catch {
        // Unknown means unlocked; the server still refuses a managed
        // write, so failing open costs nothing but a 409 message.
        if (!cancelled) setLocked(false)
      }
    })()
    return () => { cancelled = true }
  }, [isOpen, avatarId])

  const handleSave = useCallback(() => {
    if (locked) return
    setAvatarId(selected)
    onClose()
  }, [locked, selected, setAvatarId, onClose])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose],
  )

  return (
    <>
      {/* Backdrop — plain CSS transition, never inside AnimatePresence (fixes the
          StrictMode click-shield where a stranded fixed-inset-0 node eats clicks). */}
      <Backdrop open={isOpen} onClick={onClose} zClassName="z-[100]" className="bg-black/40" />

      {/* Centering layer: plain, always-mounted, transparent to clicks (they fall
          through to the Backdrop beneath → outside-click still closes). */}
      <div className="fixed inset-0 z-[101] flex items-center justify-center pointer-events-none">
        <AnimatePresence>
          {isOpen && (
            <motion.div
              key="avatar-picker-card"
              className={cn(
                'pointer-events-auto relative w-full max-w-sm mx-4 rounded-2xl shadow-lg',
                'bg-canvas-elevated border border-glass-border',
                'p-5',
              )}
              initial={{ opacity: 0, scale: 0.95, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ duration: 0.15 }}
              onKeyDown={handleKeyDown}
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

              {locked && (
                <p className="mb-3 rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
                  Your identity provider supplies your picture; it is
                  re-applied at every sign-in, so a choice made here
                  would not survive.
                </p>
              )}

              {/* Initials (default) option */}
              <button
                onClick={() => setSelected(null)}
                disabled={locked}
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
                    disabled={locked}
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
                  disabled={locked}
                  className={cn(
                    'px-4 py-1.5 text-sm font-medium rounded-lg transition-colors',
                    locked
                      ? 'bg-accent-lineage/40 text-white cursor-not-allowed'
                      : 'bg-accent-lineage text-white hover:bg-accent-lineage/90',
                  )}
                >
                  Save
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  )
}

/** Render the chosen avatar inline — returns SVG content or null (caller renders initials). */
export function useAvatarContent() {
  const avatarId = usePreferencesStore((s) => s.avatarId)
  const avatar = avatarId ? AVATARS.find((a) => a.id === avatarId) : null
  return avatar ?? null
}
