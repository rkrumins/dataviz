/**
 * PersonHoverCard — rich hover card for a person on a view: who created it, last
 * edited it or published its latest data, with what they did as role lines.
 *
 * Used in the Explorer list/card/drawer wherever a person is surfaced.
 * Replaces the native ``title`` tooltip with a modern floating panel
 * that shows avatar + full name + email — closer to the GitHub / Linear
 * user-hover pattern than a barebones browser tooltip.
 *
 * Design goals:
 * - 300 ms hover delay so incidental passes don't flash a card
 * - Smart edge-aware positioning so it never clips the viewport
 * - Pointer-events disabled on the card itself so it never blocks clicks
 *   on content underneath
 * - framer-motion fade + slight scale for a tactile feel
 * - No extra runtime deps (uses framer-motion already bundled)
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { avatarPaletteFor, initialsOf } from '@/lib/avatar'
import { UserAvatar } from '@/components/ui/UserAvatar'

/** Where the card sits: `top` when it opens below its trigger, `bottom` when above. */
interface Placement {
  top?: number
  bottom?: number
  left: number
  align: 'start' | 'end'
}

interface PersonHoverCardProps {
  /** The raw user id recorded on the view — shown only as secondary/mono detail, never as the primary label. */
  userId?: string | null
  /** Server-resolved display name (preferred primary label). */
  displayName?: string | null
  /** Their email, shown as secondary line. */
  email?: string | null
  /** Their picked avatar illustration, when known. */
  avatarId?: string | null
  /** What they did to the view, one chip each — "Created · 3 Oct". */
  roles?: readonly string[]
  /** Children are the trigger element (badge, avatar, row cell, …). */
  children: React.ReactElement<React.HTMLAttributes<HTMLElement>>
  /** Optional accent color for the avatar ring. */
  accentClassName?: string
  /** Milliseconds of hover before the card appears. Default 300 ms. */
  openDelayMs?: number
  /** Milliseconds after the pointer leaves before the card hides. */
  closeDelayMs?: number
}

export function PersonHoverCard({
  userId,
  displayName,
  email,
  avatarId,
  roles = ['Creator'],
  children,
  accentClassName,
  openDelayMs = 300,
  closeDelayMs = 120,
}: PersonHoverCardProps) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<Placement | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const name = displayName?.trim() || 'Unknown'
  const hasIdentity = !!(displayName || email || userId)

  // Compute card placement relative to the trigger.
  function computeCoords(): Placement | null {
    const el = triggerRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const cardWidth = 260
    const margin = 8
    // Default: below the trigger, aligned to the left edge.
    let left = rect.left
    let align: 'start' | 'end' = 'start'
    // If card would overflow the right edge, flip to right-aligned.
    if (left + cardWidth + margin > window.innerWidth) {
      left = rect.right - cardWidth
      align = 'end'
    }
    if (left < margin) left = margin
    // Below the trigger, or above it in the lower half of the window: a person on
    // the bottom row of cards opened a card that ran off the foot of the screen.
    if (rect.top < window.innerHeight / 2) return { top: rect.bottom + margin, left, align }
    return { bottom: window.innerHeight - rect.top + margin, left, align }
  }

  function handleEnter() {
    if (!hasIdentity) return
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
    openTimer.current = setTimeout(() => {
      setCoords(computeCoords())
      setOpen(true)
    }, openDelayMs)
  }

  function handleLeave() {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null }
    closeTimer.current = setTimeout(() => setOpen(false), closeDelayMs)
  }

  useEffect(() => () => {
    if (openTimer.current) clearTimeout(openTimer.current)
    if (closeTimer.current) clearTimeout(closeTimer.current)
  }, [])

  // Recompute on scroll / resize while open so the card follows the trigger.
  useEffect(() => {
    if (!open) return
    const update = () => setCoords(computeCoords())
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [open])

  // Clone the trigger and attach the hover handlers + ref.
  const trigger = (() => {
    const childProps = {
      ...children.props,
      onMouseEnter: (e: React.MouseEvent) => {
        children.props.onMouseEnter?.(e as React.MouseEvent<HTMLElement>)
        handleEnter()
      },
      onMouseLeave: (e: React.MouseEvent) => {
        children.props.onMouseLeave?.(e as React.MouseEvent<HTMLElement>)
        handleLeave()
      },
      onFocus: (e: React.FocusEvent) => {
        children.props.onFocus?.(e as React.FocusEvent<HTMLElement>)
        handleEnter()
      },
      onBlur: (e: React.FocusEvent) => {
        children.props.onBlur?.(e as React.FocusEvent<HTMLElement>)
        handleLeave()
      },
      ref: (node: HTMLElement | null) => {
        triggerRef.current = node
        // Forward to any existing ref on the child.
        const existingRef = (children as { ref?: React.Ref<HTMLElement> }).ref
        if (typeof existingRef === 'function') {
          existingRef(node)
        } else if (existingRef && typeof existingRef === 'object') {
          (existingRef as React.MutableRefObject<HTMLElement | null>).current = node
        }
      },
    }
    return { ...children, props: childProps }
  })()

  return (
    <>
      {trigger}
      {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {open && coords && (
            <motion.div
              // From the trigger's side: down when below it, up when above.
              initial={{ opacity: 0, y: coords.top === undefined ? 4 : -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: coords.top === undefined ? 4 : -4, scale: 0.98 }}
              transition={{ duration: 0.14, ease: 'easeOut' }}
              style={{ top: coords.top, bottom: coords.bottom, left: coords.left, width: 260 }}
              className={cn(
                'fixed z-[1000] pointer-events-none',
                'rounded-xl border border-glass-border bg-canvas-elevated shadow-xl',
                'backdrop-blur-sm',
              )}
              role="tooltip"
            >
              <div className="p-3 flex items-start gap-3">
                {(() => {
                  // Deterministic swatch per user id when no override is
                  // passed — keeps the avatar identical across the filter
                  // dropdown, hover card, and card footer for recognition.
                  const palette = avatarPaletteFor(userId ?? name)
                  const avatarClass = accentClassName ?? cn(palette.bg, palette.text)
                  return (
                    <UserAvatar
                      userId={userId}
                      name={name}
                      avatarId={avatarId}
                      className="w-10 h-10 text-xs font-bold"
                      fallback={(
                        <span
                          className={cn(
                            'flex h-full w-full items-center justify-center rounded-full',
                            avatarClass,
                          )}
                          aria-hidden
                        >
                          {initialsOf(name)}
                        </span>
                      )}
                    />
                  )
                })()}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-ink truncate">
                    {name}
                  </div>
                  {email && (
                    <div className="text-[11px] text-ink-muted truncate mt-0.5">
                      {email}
                    </div>
                  )}
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {roles.map(role => (
                      <span key={role} className="inline-flex items-center rounded-full bg-black/[0.04] dark:bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium text-ink-muted">
                        {role}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              {/* User id as a dim footer for power-users / debugging. */}
              {userId && (
                <div className="border-t border-glass-border/60 px-3 py-1.5 text-[10px] text-ink-muted/60 font-mono truncate">
                  {userId}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}
