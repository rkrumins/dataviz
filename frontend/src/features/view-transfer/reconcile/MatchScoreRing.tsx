/**
 * The match score, as a ring: the share of the view's entities found in the target graph.
 * Animates from where it was to where it is, so a re-check that lifts the score is SEEN to.
 */
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { ReconcileVerdict } from '@/services/viewTransferApiService'

const TONE: Record<ReconcileVerdict, { stroke: string; text: string }> = {
  ready: { stroke: 'stroke-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
  attention: { stroke: 'stroke-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  blocked: { stroke: 'stroke-rose-500', text: 'text-rose-600 dark:text-rose-400' },
}

export function MatchScoreRing({ rate, verdict, size = 132, label = 'matched', projected = false }: {
  /** 0..1, or null when nothing could be checked. */
  rate: number | null
  verdict: ReconcileVerdict
  size?: number
  label?: string
  /** The score reflects choices not yet re-checked by the server. */
  projected?: boolean
}) {
  const stroke = Math.max(6, Math.round(size / 13))
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const value = rate ?? 0
  const tone = TONE[verdict]
  const shown = rate === null ? '—' : `${(value * 100).toFixed(value >= 0.995 || value === 0 ? 0 : 1)}%`
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img"
      aria-label={rate === null ? 'Nothing could be checked' : `${shown} ${label}`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke}
          className="stroke-black/[0.06] dark:stroke-white/[0.08]" />
        <motion.circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} strokeLinecap="round"
          className={cn(tone.stroke, projected && 'opacity-60')}
          strokeDasharray={circumference}
          initial={false}
          animate={{ strokeDashoffset: circumference * (1 - value) }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn('font-bold tabular-nums leading-none', tone.text)} style={{ fontSize: size / 5 }}>{shown}</span>
        <span className="text-[10px] text-ink-muted mt-1">{projected ? 'after your choices' : label}</span>
      </div>
    </div>
  )
}
