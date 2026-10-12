/**
 * BulkLinkFlow — the links about to be made, drawn: sources on the left,
 * targets on the right, and a curve for every pair between the entities on
 * show — green for a link that will be added, amber and dashed for one that
 * will be skipped. The relationship rides on the connector.
 *
 * It is the answer to "what will this do?" before anything is staged, so it
 * updates as the reader picks. Swap moves the entities to the other side —
 * the one piece of motion, because it is the change the reader asked for.
 */
import { LayoutGroup, motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import type { EntityLook } from './useBulkLinkModel'

export interface BulkLinkFlowProps {
  sources: readonly string[]
  targets: readonly string[]
  /** The canvas selection — its entities carry the selection's tint. */
  selection: ReadonlySet<string>
  labelFor: (id: string) => string
  lookOf: (id: string) => EntityLook
  /** A pair's verdict; undefined while there is no relationship to judge by. */
  verdictOf: (source: string, target: string) => 'ok' | 'skip' | undefined
  relationship: string | null
  onSwap?: () => void
  compact?: boolean
}

export function BulkLinkFlow({
  sources, targets, selection, labelFor, lookOf, verdictOf, relationship, onSwap, compact = false,
}: BulkLinkFlowProps) {
  const shown = compact ? 3 : 4
  const rowH = compact ? 26 : 32
  const gap = compact ? 4 : 6
  const width = compact ? 64 : 124
  const src = sources.slice(0, shown)
  const tgt = targets.slice(0, shown)
  const rows = Math.max(src.length + (sources.length > shown ? 1 : 0), tgt.length + (targets.length > shown ? 1 : 0), 1)
  const height = rows * rowH + (rows - 1) * gap
  const y = (i: number) => i * (rowH + gap) + rowH / 2

  return (
    <LayoutGroup>
      <div className="flex items-stretch" aria-label="The links to be made">
        <Side
          ids={sources} shown={shown} rowH={rowH} gap={gap} compact={compact}
          selection={selection} labelFor={labelFor} lookOf={lookOf}
          empty="Choose sources" align="left"
        />
        <div className="relative shrink-0" style={{ width, height }}>
          <svg width={width} height={height} className="absolute inset-0 overflow-visible" aria-hidden>
            {src.map((s, i) =>
              tgt.map((t, j) => {
                const verdict = verdictOf(s, t)
                const x0 = 2
                const x1 = width - 2
                const d = `M ${x0} ${y(i)} C ${width / 2} ${y(i)}, ${width / 2} ${y(j)}, ${x1} ${y(j)}`
                return (
                  <motion.path
                    key={`${s}\u0000${t}`}
                    d={d}
                    fill="none"
                    initial={{ pathLength: 0, opacity: 0 }}
                    animate={{ pathLength: 1, opacity: 1 }}
                    transition={{ duration: 0.35, ease: 'easeOut' }}
                    strokeWidth={1.6}
                    strokeLinecap="round"
                    strokeDasharray={verdict === 'skip' ? '3 3' : undefined}
                    className={cn(
                      verdict === 'ok' && 'stroke-lineage-out',
                      verdict === 'skip' && 'stroke-amber-500',
                      verdict === undefined && 'stroke-accent-lineage',
                    )}
                  />
                )
              }),
            )}
            {(src.length === 0 || tgt.length === 0) && (
              <path
                d={`M 4 ${height / 2} L ${width - 8} ${height / 2}`}
                className="stroke-accent-lineage"
                strokeWidth={1.6}
                strokeDasharray="4 4"
                fill="none"
              />
            )}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 pointer-events-none">
            {relationship && !compact && (
              <span className="px-2 py-0.5 rounded-full bg-canvas-elevated border border-glass-border text-[10.5px] font-semibold text-ink shadow-sm max-w-full truncate">
                {relationship}
              </span>
            )}
            {onSwap && (
              <button
                type="button"
                onClick={onSwap}
                aria-label="Swap direction"
                title="Swap which side feeds which"
                className="pointer-events-auto flex items-center gap-1 px-2 py-0.5 rounded-full bg-canvas-elevated border border-glass-border text-[10.5px] font-medium text-accent-lineage shadow-sm hover:border-accent-lineage/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 transition-colors"
              >
                <LucideIcons.ArrowLeftRight className="w-3 h-3" />
                {!compact && 'Swap'}
              </button>
            )}
          </div>
        </div>
        <Side
          ids={targets} shown={shown} rowH={rowH} gap={gap} compact={compact}
          selection={selection} labelFor={labelFor} lookOf={lookOf}
          empty="Choose targets" align="right"
        />
      </div>
    </LayoutGroup>
  )
}

function Side({
  ids, shown, rowH, gap, compact, selection, labelFor, lookOf, empty, align,
}: {
  ids: readonly string[]
  shown: number
  rowH: number
  gap: number
  compact: boolean
  selection: ReadonlySet<string>
  labelFor: (id: string) => string
  lookOf: (id: string) => EntityLook
  empty: string
  align: 'left' | 'right'
}) {
  const rest = ids.length - Math.min(ids.length, shown)
  return (
    <ul className="flex-1 min-w-0 flex flex-col" style={{ gap }}>
      {ids.length === 0 && (
        <li
          className={cn('flex items-center px-2.5 rounded-lg border border-dashed border-glass-border text-ink-muted', compact ? 'text-[11px]' : 'text-[12px]', align === 'right' && 'justify-end')}
          style={{ height: rowH }}
        >
          {empty}
        </li>
      )}
      {ids.slice(0, shown).map((id) => {
        const look = lookOf(id)
        const mine = selection.has(id)
        return (
          <motion.li
            key={id}
            layoutId={`bulk-link-${id}`}
            transition={{ type: 'spring', stiffness: 420, damping: 36 }}
            className={cn(
              'flex items-center gap-1.5 min-w-0 px-2 rounded-lg border',
              mine ? 'border-accent-lineage/35 bg-accent-lineage/10' : 'border-glass-border bg-canvas-elevated',
            )}
            style={{ height: rowH }}
            title={`${labelFor(id)} · ${look.typeName}`}
          >
            <span
              className={cn('shrink-0 rounded-md grid place-items-center', compact ? 'w-4 h-4' : 'w-5 h-5')}
              style={{ backgroundColor: `${look.color}22`, color: look.color }}
            >
              <DynamicIcon name={look.icon} className={compact ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
            </span>
            <span className={cn('truncate text-ink', compact ? 'text-[11px]' : 'text-[12px] font-medium')}>{labelFor(id)}</span>
          </motion.li>
        )
      })}
      {rest > 0 && (
        <li
          className={cn('flex items-center px-2 text-ink-muted', compact ? 'text-[10.5px]' : 'text-[11px]', align === 'right' && 'justify-end')}
          style={{ height: rowH }}
        >
          +{rest.toLocaleString()} more
        </li>
      )}
    </ul>
  )
}
