/**
 * CoverageVisuals — Shared coverage visualization components used by
 * both SemanticStep (onboarding wizard) and SuggestConfirmDialog (ontology page).
 *
 * Extracted from SuggestConfirmDialog to avoid duplication.
 */
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MergedVariantSpelling } from '@/services/ontologyDefinitionService'

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

function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/**
 * MergedVariantsAdvisory — types the source graph spells more than one way. The
 * suggester folds each into ONE canonical declared id (green); the off-spellings are
 * case-drift that won't hit FalkorDB's index until the graph is normalized. Shared by
 * the Suggest dialog and the onboarding SemanticStep so the guidance reads identically.
 */
export function MergedVariantsAdvisory({ variants }: { variants: Record<string, MergedVariantSpelling[]> }) {
  const entries = Object.entries(variants)
  if (entries.length === 0) return null
  const total = entries.length
  return (
    <div className="rounded-xl border border-amber-300/40 dark:border-amber-800/30 bg-amber-50/50 dark:bg-amber-950/15 p-3.5">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
            {total} type{total !== 1 ? 's are' : ' is'} spelled more than one way in your graph
          </p>
          <p className="text-[11px] text-amber-700/90 dark:text-amber-400/90 mt-0.5 leading-relaxed">
            Each is modelled as a single declared type (the canonical spelling, in green). FalkorDB is case-sensitive,
            so the other spellings won't hit its index until the graph is normalized — the <span className="font-semibold">Health</span> tab
            tracks this as case drift.
          </p>
          <div className="mt-2 space-y-1.5">
            {entries.slice(0, 4).map(([canonical, spellings]) => (
              <div key={canonical} className="flex items-center gap-1.5 flex-wrap text-[11px]">
                {spellings.map(s => {
                  const isCanonical = s.spelling === canonical
                  return (
                    <span key={s.spelling} className={cn(
                      'inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[10px] border',
                      isCanonical
                        ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/25'
                        : 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20 line-through decoration-amber-500/40',
                    )}>
                      {s.spelling}
                      <span className="opacity-60 no-underline">{compactCount(s.count)}</span>
                    </span>
                  )
                })}
              </div>
            ))}
            {entries.length > 4 && (
              <p className="text-[10px] text-amber-600/70 dark:text-amber-500/70">+{entries.length - 4} more</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
