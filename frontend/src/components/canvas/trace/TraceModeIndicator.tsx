/**
 * TraceModeIndicator — semantic, mode-coloured badge that tells the user
 * exactly which trace they're running.
 *
 * Mirrors the EntityDrawer's trace action vocabulary (Root Cause / Impact /
 * Full Lineage) so the canvas-level state matches the entry-point labels
 * that originated the trace. Replaces the generic "Active Trace" badge in
 * the TraceDockTitleBar.
 *
 * Modes:
 *   - upstream   → blue,    "Root Cause"   ("Upstream lineage")
 *   - downstream → emerald, "Impact"       ("Downstream lineage")
 *   - full       → purple,  "Full Lineage" ("Both directions")
 *
 * Loading state swaps the directional icon for a spinner and pivots the
 * label to "Computing…" so the mode chrome stays visible while the new
 * /trace/v2 result is fetched.
 */

import { motion } from 'framer-motion'
import {
  ArrowUpLeft,
  ArrowDownRight,
  GitBranch,
  Loader2,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export type TraceMode = 'upstream' | 'downstream' | 'full'

/** Single source of truth for translating direction flags → semantic mode. */
export function deriveTraceMode(showUpstream: boolean, showDownstream: boolean): TraceMode {
  if (showUpstream && !showDownstream) return 'upstream'
  if (!showUpstream && showDownstream) return 'downstream'
  return 'full'
}

interface ModeStyle {
  /** Headline label — matches the EntityDrawer button label exactly. */
  label: string
  /** Sublabel — names the lineage direction in plain language. */
  sublabel: string
  /** Long-form explanation surfaced via hover tooltip + aria-label. */
  meaning: string
  Icon: LucideIcon
  /** Tailwind gradient classes for the 40px identity badge. */
  gradient: string
  /** Tailwind shadow class colouring the badge glow. */
  shadow: string
  /** Tailwind border colour for the badge. */
  border: string
  /** Pulsing dot — ping ring + solid dot — colour. */
  pulseRing: string
  pulseDot: string
  /** Drop-shadow glow on the icon (rgba so it stays visible on dark bg). */
  glow: string
  /** "TRACE" micro-pill (visible on xl+ viewports). */
  pillText: string
  pillBg: string
  pillBorder: string
}

const MODE_STYLES: Record<TraceMode, ModeStyle> = {
  upstream: {
    label: 'Root Cause',
    sublabel: 'Upstream lineage',
    meaning:
      'Tracing data backward toward its sources — find where this entity originated.',
    Icon: ArrowUpLeft,
    gradient: 'from-blue-500 to-blue-600',
    shadow: 'shadow-blue-500/30',
    border: 'border-blue-500/60',
    pulseRing: 'bg-blue-500/60',
    pulseDot: 'bg-blue-500',
    glow: 'drop-shadow-[0_0_4px_rgba(59,130,246,0.6)]',
    pillText: 'text-blue-600 dark:text-blue-400',
    pillBg: 'bg-blue-500/15',
    pillBorder: 'border-blue-500/30',
  },
  downstream: {
    label: 'Impact',
    sublabel: 'Downstream lineage',
    meaning:
      'Tracing data forward toward its consumers — see what depends on this entity.',
    Icon: ArrowDownRight,
    gradient: 'from-emerald-500 to-emerald-600',
    shadow: 'shadow-emerald-500/30',
    border: 'border-emerald-500/60',
    pulseRing: 'bg-emerald-500/60',
    pulseDot: 'bg-emerald-500',
    glow: 'drop-shadow-[0_0_4px_rgba(16,185,129,0.6)]',
    pillText: 'text-emerald-600 dark:text-emerald-400',
    pillBg: 'bg-emerald-500/15',
    pillBorder: 'border-emerald-500/30',
  },
  full: {
    label: 'Full Lineage',
    sublabel: 'Both directions',
    meaning:
      'Tracing data in both directions — full end-to-end view from sources through to consumers.',
    Icon: GitBranch,
    gradient: 'from-purple-500 to-purple-600',
    shadow: 'shadow-purple-500/30',
    border: 'border-purple-500/60',
    pulseRing: 'bg-purple-500/60',
    pulseDot: 'bg-purple-500',
    glow: 'drop-shadow-[0_0_4px_rgba(168,85,247,0.6)]',
    pillText: 'text-purple-600 dark:text-purple-400',
    pillBg: 'bg-purple-500/15',
    pillBorder: 'border-purple-500/30',
  },
}

export interface TraceModeIndicatorProps {
  mode: TraceMode
  isLoading?: boolean
  /** When true, hide the text block (icon-only). Useful below sm viewports. */
  iconOnly?: boolean
  className?: string
}

export function TraceModeIndicator({
  mode,
  isLoading,
  iconOnly,
  className,
}: TraceModeIndicatorProps) {
  const style = MODE_STYLES[mode]
  const Icon = style.Icon
  const headline = isLoading ? 'Computing…' : style.label
  const sub = isLoading ? 'building lineage' : style.sublabel
  const ariaLabel = `${style.label} trace mode. ${style.meaning}`

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      title={style.meaning}
      className={cn('relative flex items-center gap-2.5 shrink-0', className)}
    >
      {/* Identity badge — mode-coloured gradient + live pulse dot */}
      <motion.div
        key={`badge-${mode}`}
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        className={cn(
          'relative w-10 h-10 rounded-xl flex items-center justify-center shrink-0',
          'bg-gradient-to-br', style.gradient,
          'border', style.border,
          'shadow-lg', style.shadow,
        )}
      >
        {isLoading ? (
          <Loader2
            className="w-5 h-5 text-white animate-spin motion-reduce:animate-none"
            strokeWidth={2.4}
            aria-hidden
          />
        ) : (
          <Icon
            className={cn('w-5 h-5 text-white', style.glow)}
            strokeWidth={2.4}
            aria-hidden
          />
        )}
        {/* Pulse — anchored bottom-right; signals "trace is live" */}
        <span
          className="absolute -bottom-0.5 -right-0.5 inline-flex w-2.5 h-2.5"
          aria-hidden
        >
          <span
            className={cn(
              'absolute inset-0 rounded-full animate-ping motion-reduce:animate-none',
              style.pulseRing,
            )}
          />
          <span
            className={cn(
              'relative w-2.5 h-2.5 rounded-full border-2 border-canvas-elevated',
              style.pulseDot,
            )}
          />
        </span>
      </motion.div>

      {/* Text block — semantic label + sublabel. Crossfades on mode change. */}
      {!iconOnly && (
        <motion.div
          key={`text-${mode}-${isLoading ? 'loading' : 'idle'}`}
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="flex flex-col leading-tight min-w-0"
        >
          <div className="flex items-center gap-1.5">
            <span className="text-[12px] font-bold text-ink tracking-tight whitespace-nowrap">
              {headline}
            </span>
            {!isLoading && (
              <span
                className={cn(
                  'hidden xl:inline-flex shrink-0 px-1.5 py-0.5 rounded-md',
                  'text-[9px] font-bold uppercase tracking-wider border',
                  style.pillBg,
                  style.pillText,
                  style.pillBorder,
                )}
              >
                Trace
              </span>
            )}
          </div>
          <span className="text-[10px] text-ink-muted tracking-wide whitespace-nowrap">
            {sub}
          </span>
        </motion.div>
      )}
    </div>
  )
}
