/**
 * CoverageVisuals — Shared coverage visualization components used by
 * both SemanticStep (onboarding wizard) and SuggestConfirmDialog (ontology page).
 *
 * Extracted from SuggestConfirmDialog to avoid duplication.
 */
import { cn } from '@/lib/utils'

/** Mini donut-style ring for coverage percentage. */
export function CoverageRing({ percent, size = 52, stroke = 5, color }: {
  percent: number; size?: number; stroke?: number; color: string
}) {
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const offset = circ - (percent / 100) * circ
  return (
    <svg width={size} height={size} className="flex-shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
        className="stroke-black/[0.04] dark:stroke-white/[0.06]" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={color} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={offset}
        className="transition-all duration-500" />
      <text x={size / 2} y={size / 2} textAnchor="middle" dy="0.35em"
        transform={`rotate(90, ${size / 2}, ${size / 2})`}
        className="fill-current text-ink font-bold"
        style={{ fontSize: size * 0.28 }}>
        {percent}%
      </text>
    </svg>
  )
}

/** Tiny inline bar with label showing covered/total ratio. */
export function MiniBar({ covered, total, label, colorClass }: {
  covered: number; total: number; label: string; colorClass: string
}) {
  const pct = total > 0 ? Math.round((covered / total) * 100) : 0
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider">{label}</span>
        <span className="text-[11px] font-bold text-ink">{covered}/{total}</span>
      </div>
      <div className="w-full h-1.5 rounded-full bg-black/[0.04] dark:bg-white/[0.06]">
        <div className={cn('h-full rounded-full transition-all duration-500', colorClass)}
          style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/** Returns the appropriate color for a coverage percentage. */
export function coverageColor(pct: number): string {
  if (pct >= 80) return '#10b981'
  if (pct >= 50) return '#f59e0b'
  return '#ef4444'
}

/** Returns the appropriate Tailwind bar class for a coverage percentage. */
export function coverageBarClass(pct: number): string {
  if (pct >= 80) return 'bg-emerald-500'
  if (pct >= 50) return 'bg-amber-500'
  return 'bg-red-400'
}
