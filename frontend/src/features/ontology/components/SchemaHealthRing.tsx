/**
 * SchemaHealthRing — donut ring visualising a computed schema health score
 * with up to three actionable suggestions to improve it.
 *
 * Health score breakdown (0–100%):
 *   20%  Entity types with descriptions
 *   25%  Relationships with source AND target types defined
 *   30%  Coverage percent (pass-through, or 100 if unavailable)
 *   10%  Entity types with non-default icons (not "Box")
 *   15%  Has containment hierarchy (boolean)
 */
import { useMemo } from 'react'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface SchemaHealthRingProps {
  entityTypes: Array<{
    id: string
    name: string
    description?: string
    visual: { icon: string; color: string }
  }>
  relationships: Array<{
    id: string
    name: string
    sourceTypes: string[]
    targetTypes: string[]
  }>
  containmentCount: number
  /** External coverage %, or null if not available. */
  coveragePercent: number | null
  /** Navigate to a specific tab in the schema page. */
  onNavigateTab: (tab: string) => void
}

/* ------------------------------------------------------------------ */
/*  Score computation                                                  */
/* ------------------------------------------------------------------ */

interface HealthBreakdown {
  score: number
  /** Up to 3 actionable improvement suggestions. */
  actions: Array<{ label: string; tab: string }>
}

function computeHealth(
  entityTypes: SchemaHealthRingProps['entityTypes'],
  relationships: SchemaHealthRingProps['relationships'],
  containmentCount: number,
  coveragePercent: number | null,
): HealthBreakdown {
  const actions: Array<{ label: string; tab: string }> = []

  // --- 1. Descriptions (20%) -------------------------------------------
  const withDesc = entityTypes.filter(
    e => e.description && e.description.trim().length > 0,
  ).length
  const descRatio = entityTypes.length > 0 ? withDesc / entityTypes.length : 1
  const descScore = descRatio * 20
  const missingDescCount = entityTypes.length - withDesc
  if (missingDescCount > 0) {
    actions.push({
      label: `Add descriptions to ${missingDescCount} entity type${missingDescCount > 1 ? 's' : ''}`,
      tab: 'entities',
    })
  }

  // --- 2. Relationships with source+target (25%) -----------------------
  const wellDefined = relationships.filter(
    r => r.sourceTypes.length > 0 && r.targetTypes.length > 0,
  ).length
  const relRatio = relationships.length > 0 ? wellDefined / relationships.length : 1
  const relScore = relRatio * 25
  const incompleteRels = relationships.length - wellDefined
  if (incompleteRels > 0) {
    actions.push({
      label: `Define source/target for ${incompleteRels} relationship${incompleteRels > 1 ? 's' : ''}`,
      tab: 'relationships',
    })
  }

  // --- 3. Coverage (30%) -----------------------------------------------
  const effectiveCoverage = coveragePercent ?? 100
  const coverageScore = (effectiveCoverage / 100) * 30

  // --- 4. Non-default icons (10%) --------------------------------------
  const withIcon = entityTypes.filter(e => e.visual.icon !== 'Box').length
  const iconRatio = entityTypes.length > 0 ? withIcon / entityTypes.length : 1
  const iconScore = iconRatio * 10
  const defaultIconCount = entityTypes.length - withIcon
  if (defaultIconCount > 0) {
    actions.push({
      label: `Customize icons for ${defaultIconCount} entity type${defaultIconCount > 1 ? 's' : ''}`,
      tab: 'entities',
    })
  }

  // --- 5. Containment hierarchy (15%) ----------------------------------
  const containmentScore = containmentCount > 0 ? 15 : 0
  if (containmentCount === 0) {
    actions.push({
      label: 'Set up a containment hierarchy',
      tab: 'hierarchy',
    })
  }

  const score = Math.round(descScore + relScore + coverageScore + iconScore + containmentScore)

  // Return at most 3 actions, prioritised by insertion order (most impactful first).
  return { score, actions: actions.slice(0, 3) }
}

/* ------------------------------------------------------------------ */
/*  Donut ring SVG                                                     */
/* ------------------------------------------------------------------ */

const RING_SIZE = 80
const RING_STROKE = 6

function HealthDonut({ score }: { score: number }) {
  const r = (RING_SIZE - RING_STROKE) / 2
  const circ = 2 * Math.PI * r
  const offset = circ - (score / 100) * circ

  // Colour based on score threshold
  const ringColor =
    score >= 80
      ? '#22c55e' // green-500
      : score >= 50
        ? '#f59e0b' // amber-500
        : '#ef4444' // red-500

  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      className="flex-shrink-0 -rotate-90"
    >
      {/* Background track */}
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={r}
        fill="none"
        className="stroke-black/[0.04] dark:stroke-white/[0.06]"
        strokeWidth={RING_STROKE}
      />
      {/* Foreground arc */}
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={r}
        fill="none"
        stroke={ringColor}
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        className="transition-all duration-700"
      />
      {/* Center label — uses SVG transform instead of CSS for Safari compatibility */}
      <text
        x={RING_SIZE / 2}
        y={RING_SIZE / 2}
        textAnchor="middle"
        dy="0.35em"
        transform={`rotate(90, ${RING_SIZE / 2}, ${RING_SIZE / 2})`}
        className="fill-current text-ink font-bold"
        style={{ fontSize: RING_SIZE * 0.26 }}
      >
        {score}%
      </text>
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function SchemaHealthRing({
  entityTypes,
  relationships,
  containmentCount,
  coveragePercent,
  onNavigateTab,
}: SchemaHealthRingProps) {
  const { score, actions } = useMemo(
    () => computeHealth(entityTypes, relationships, containmentCount, coveragePercent),
    [entityTypes, relationships, containmentCount, coveragePercent],
  )

  const StatusIcon = score >= 80 ? CheckCircle2 : AlertTriangle
  const statusColor = score >= 80 ? 'text-emerald-500' : score >= 50 ? 'text-amber-500' : 'text-red-500'

  return (
    <div className="flex flex-col items-center gap-3">
      {/* Donut */}
      <HealthDonut score={score} />

      {/* Status label */}
      <div className="flex items-center gap-1.5">
        <StatusIcon className={cn('w-3.5 h-3.5', statusColor)} />
        <span className="text-xs font-semibold text-ink-muted">
          Schema Health
        </span>
      </div>

      {/* Actionable items */}
      {actions.length > 0 && (
        <div className="space-y-1 w-full max-w-[220px]">
          {actions.map((action, idx) => (
            <button
              key={idx}
              onClick={() => onNavigateTab(action.tab)}
              className="block w-full text-left text-[11px] leading-snug text-ink-muted hover:text-ink transition-colors cursor-pointer px-1 py-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5"
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
