/**
 * TraceSharePopover — hand this trace to someone else (2026-08-23).
 *
 * A trace is a finding, and findings get passed on. Until now that meant a
 * screenshot: unreadable at depth, un-openable, and stale the moment the
 * lineage moves. This copies a link that reopens the trace — same focus,
 * same direction, same hop limits, and (unless you say otherwise) the same
 * cards you had open.
 *
 * It states what travels BEFORE the copy rather than after: the point of a
 * share popover over a bare icon is that the sender can see what they are
 * sending, and choose. The one choice offered is the only one that changes
 * what the recipient sees — the picture, or the plain question.
 *
 * Portaled and fixed-anchored ABOVE the trigger for the same reason
 * `TraceRecentPopover` is (the dock is bottom-anchored and clips its own
 * overflow), and with no exit animation, for the same reason again: an
 * interrupted exit must never strand an invisible click-blocker.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { ArrowDownRight, ArrowUpLeft, Check, GitBranch, Link2, Share2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTraceEscStack } from './useTraceEscStack'

export interface TraceShareSummary {
  /** The traced entity's name, as the board knows it. */
  label: string
  direction: 'up' | 'down' | 'both'
  depthUp: number
  depthDown: number
  /** Cards the reader has open right now — what "the picture" amounts to. */
  openCards: number
  /** The link itself, built on demand from what is on screen. */
  buildLink: (includePicture: boolean) => string
}

export interface TraceSharePopoverProps extends TraceShareSummary {
  onClose: () => void
  /** The trigger button — the panel anchors above it. */
  triggerRef: React.RefObject<HTMLElement | null>
}

const MODE = {
  up: { Icon: ArrowUpLeft, tone: 'text-cyan-600 dark:text-cyan-400 bg-cyan-500/10', name: 'Root cause' },
  down: { Icon: ArrowDownRight, tone: 'text-amber-600 dark:text-amber-400 bg-amber-500/10', name: 'Impact' },
  both: { Icon: GitBranch, tone: 'text-violet-600 dark:text-violet-400 bg-violet-500/10', name: 'Full lineage' },
} as const

/** "25 hops each way" / "25 hops up" — the limits, said once. */
function hopPhrase(direction: 'up' | 'down' | 'both', up: number, down: number): string {
  if (direction === 'up') return `${up} hop${up === 1 ? '' : 's'} upstream`
  if (direction === 'down') return `${down} hop${down === 1 ? '' : 's'} downstream`
  return up === down ? `${up} hop${up === 1 ? '' : 's'} each way` : `${up} up · ${down} down`
}

export function TraceSharePopover({
  label,
  direction,
  depthUp,
  depthDown,
  openCards,
  buildLink,
  onClose,
  triggerRef,
}: TraceSharePopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const copyRef = useRef<HTMLButtonElement>(null)
  const [includePicture, setIncludePicture] = useState(true)
  const [copied, setCopied] = useState(false)
  /** Set only when the clipboard refused (insecure context, denied
   *  permission): the link is shown to be selected by hand rather than the
   *  gesture failing silently. */
  const [manualLink, setManualLink] = useState<string | null>(null)

  useTraceEscStack(true, onClose, 100)

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (!target) return
      if (panelRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [onClose, triggerRef])

  useEffect(() => { copyRef.current?.focus() }, [])

  const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(null)
  useEffect(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setAnchor({ right: window.innerWidth - rect.right, bottom: window.innerHeight - rect.top + 6 })
  }, [triggerRef])

  const copy = async () => {
    const url = buildLink(includePicture)
    try {
      await navigator.clipboard.writeText(url)
      setManualLink(null)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setManualLink(url)
    }
  }

  if (!anchor) return null
  const mode = MODE[direction]
  const carriesPicture = includePicture && openCards > 0

  return createPortal(
    <motion.div
      ref={panelRef}
      data-canvas-interactive
      role="dialog"
      aria-label="Share this trace"
      initial={{ opacity: 0, y: 4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      style={{ position: 'fixed', right: anchor.right, bottom: anchor.bottom, zIndex: 1000 }}
      className={cn(
        'w-[320px] rounded-xl overflow-hidden',
        'bg-canvas-elevated/98 backdrop-blur-2xl',
        'border border-glass-border shadow-glass-lg',
      )}
    >
      <div className="px-3.5 pt-2.5 pb-2 border-b border-glass-border/40">
        <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-ink-muted">
          <Share2 className="w-3 h-3" /> Share this trace
        </span>
      </div>

      {/* WHAT TRAVELS. Named before the copy, not implied after it. */}
      <div className="px-3.5 py-3">
        <div className="flex items-start gap-2.5">
          <span className={cn('flex items-center justify-center w-7 h-7 rounded-lg flex-shrink-0', mode.tone)}>
            <mode.Icon className="w-4 h-4" strokeWidth={2.2} />
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-ink truncate" title={label}>{label}</p>
            <p className="text-[11px] text-ink-muted">
              {mode.name} · {hopPhrase(direction, depthUp, depthDown)}
              {carriesPicture && ` · ${openCards} card${openCards === 1 ? '' : 's'} open`}
            </p>
          </div>
        </div>

        {openCards > 0 && (
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="block text-[11.5px] font-medium text-ink">Include the open cards</span>
              <span className="block text-[10.5px] text-ink-muted leading-snug">
                {includePicture ? 'They land on your exact picture' : 'They land on it as it first draws'}
              </span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={includePicture}
              aria-label="Include the open cards"
              onClick={() => setIncludePicture(v => !v)}
              className={cn(
                'relative inline-flex items-center flex-shrink-0 w-9 h-5 rounded-full transition-colors duration-200',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                includePicture ? 'bg-accent-lineage' : 'bg-black/[0.12] dark:bg-white/[0.16]',
              )}
            >
              <span
                className={cn(
                  'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200',
                  includePicture ? 'translate-x-[18px]' : 'translate-x-0.5',
                )}
              />
            </button>
          </div>
        )}

        <button
          ref={copyRef}
          type="button"
          data-share-copy
          onClick={() => { void copy() }}
          className={cn(
            'mt-3 w-full inline-flex items-center justify-center gap-2 h-9 rounded-lg text-[12.5px] font-semibold',
            'transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
            copied
              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30'
              : 'bg-accent-lineage text-white border border-accent-lineage hover:brightness-110 shadow-lg shadow-accent-lineage/25',
          )}
        >
          {copied ? <Check className="w-4 h-4" strokeWidth={2.6} /> : <Link2 className="w-4 h-4" strokeWidth={2.4} />}
          {/* Announced: the confirmation is a colour and a word, neither of
              which reaches a screen reader on its own. */}
          <span aria-live="polite">{copied ? 'Link copied' : 'Copy link'}</span>
        </button>

        {manualLink && (
          <div className="mt-2">
            <p className="text-[10.5px] text-ink-muted mb-1">Your browser blocked the clipboard — copy it by hand:</p>
            <input
              readOnly
              value={manualLink}
              aria-label="Trace link"
              onFocus={(e) => e.currentTarget.select()}
              className="w-full px-2 py-1.5 rounded-md text-[10.5px] font-mono bg-black/[0.04] dark:bg-white/[0.06] border border-glass-border text-ink"
            />
          </div>
        )}
      </div>

      <p className="px-3.5 py-2 border-t border-glass-border/40 text-[10px] leading-snug text-ink-muted/80">
        Anyone who can open this view can open the trace. It re-runs against today's lineage.
      </p>
    </motion.div>,
    document.body,
  )
}
