/**
 * RollupsChip — which lines the canvas is drawing, said where the reader looks, with the switch.
 *
 * Relationships only (the default): every line is a relationship you can open and, in a draft,
 * change — drawn between the cards that hold its ends, so a line between two cards can stand for
 * relationships between entities inside them. Roll-ups, the summaries the aggregation job
 * computes, are left out, and the chip counts the lines that were nothing but roll-ups. With
 * roll-ups: they are drawn too, and opening one says what it summarises.
 *
 * It lives at the end of the layer strip, beside the Adaptive guide; the Lineage button's menu
 * makes the same choice.
 */
import { GitBranch, Layers } from 'lucide-react'
import { HoverTip } from '@/components/ui/HoverTip'

const ACTION_CLASS =
  'px-2 py-1 rounded-md text-[11.5px] font-medium text-accent-lineage hover:bg-accent-lineage/10 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 transition-colors'

export function RollupsChip({ showRollups, hiddenCount, onChange }: {
  showRollups: boolean
  /** Lines left out because they were only roll-ups. */
  hiddenCount: number
  onChange: (showRollups: boolean) => void
}) {
  const Icon = showRollups ? Layers : GitBranch
  return (
    <span className="flex items-center gap-0.5 whitespace-nowrap" data-testid="rollups-chip">
      <HoverTip
        width="data"
        className="inline-flex"
        label={showRollups ? 'Roll-ups are drawn too' : 'Every line is a relationship'}
        detail={showRollups
          ? 'A dashed line can be a roll-up: a summary of the relationships between entities inside two cards, computed by the aggregation job. Roll-ups are read-only — open one to see what it summarises.'
          : 'Open a line to see its relationships and, in a draft, change them. A line between two cards can stand for relationships between entities inside them. Roll-ups — summaries computed by the aggregation job — are hidden.'}
      >
        <span className="flex items-center gap-1.5 pl-2 pr-1 py-1 text-[11px] font-medium text-ink-muted">
          <Icon className="w-3.5 h-3.5" aria-hidden />
          {showRollups ? 'With roll-ups' : 'Relationships only'}
          {!showRollups && hiddenCount > 0 && (
            <span className="tabular-nums"> · {hiddenCount.toLocaleString()} roll-up {hiddenCount === 1 ? 'line' : 'lines'} hidden</span>
          )}
        </span>
      </HoverTip>
      <button type="button" onClick={() => onChange(!showRollups)} className={ACTION_CLASS}>
        {showRollups ? 'Hide roll-ups' : 'Show roll-ups'}
      </button>
    </span>
  )
}
