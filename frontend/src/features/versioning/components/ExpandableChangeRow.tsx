/**
 * ExpandableChangeRow — one change, the same everywhere a list of them is shown: a summary first
 * (what it is, what happened to it, in the change colours), then — opened — its key differences,
 * then all of them. The level and what each shows are the caller's (`children(level)`); the row is
 * the frame: its colour bar, its button, its badges and its actions (shown on hover and focus).
 *
 * A row is a list item; its button is the one tab stop a list moves between (`tabIndex` from the
 * list's current row), and says whether it is open and what it opens.
 */
import { memo, useId, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChangeStatus } from '../model/changeModel'
import { CHANGE_TONE } from '../model/changeTone'
import type { RowLevel } from '@/hooks/useExpandableRows'
import { STATUS_META } from './NodeDiffBadge'

export interface ExpandableChangeRowProps {
  /** The row's button id, for the list to focus it. */
  id: string
  status: ChangeStatus
  title: ReactNode
  /** A quieter second name (qualified name, a relationship's type). */
  sub?: ReactNode
  /** The one-line summary (`ChangeSummary`). */
  summary?: ReactNode
  level: RowLevel
  current?: boolean
  onToggle: () => void
  onFocus?: () => void
  /** Always shown, beside the summary (comment counts, a decision, ×n). */
  badges?: ReactNode
  /** Shown on hover and focus (Show on canvas, Discard). */
  actions?: ReactNode
  setsize?: number
  posinset?: number
  /** What it shows opened: level 1, its key differences; level 2, all of them. */
  children?: (level: RowLevel) => ReactNode
  /** Below the header whatever the level (a rejection's reason, an open reason form). */
  footer?: ReactNode
  className?: string
}

export const ExpandableChangeRow = memo(function ExpandableChangeRow({
  id, status, title, sub, summary, level, current, onToggle, onFocus, badges, actions, setsize, posinset, children, footer, className,
}: ExpandableChangeRowProps) {
  const regionId = useId()
  const tone = CHANGE_TONE[status]
  const meta = STATUS_META[status]
  const open = level > 0
  return (
    <div role="listitem" aria-setsize={setsize} aria-posinset={posinset}
      className={cn('group/row relative mb-1 rounded-xl border transition-colors',
        open ? 'bg-canvas-elevated border-glass-border shadow-sm' : 'border-transparent hover:bg-black/[0.025] dark:hover:bg-white/[0.035]',
        current && 'ring-1 ring-accent-lineage/35',
        className)}>
      <span aria-hidden className={cn('absolute left-0 top-2 bottom-2 w-[3px] rounded-full', tone.bar)} />
      <div className="flex items-start gap-1.5 pl-2.5 pr-1.5 py-1.5">
        <button id={id} type="button" tabIndex={current ? 0 : -1} aria-expanded={open} aria-controls={open ? regionId : undefined}
          onClick={onToggle} onFocus={onFocus}
          className="flex-1 min-w-0 flex items-start gap-2 text-left rounded-lg px-1 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
          <ChevronRight className={cn('w-3.5 h-3.5 mt-1 text-ink-muted/60 shrink-0 motion-safe:transition-transform', open && 'rotate-90')} aria-hidden />
          <span className={cn('mt-0.5 w-5 h-5 rounded-md flex items-center justify-center shrink-0', tone.chip)}>
            <meta.Icon className="w-3 h-3" aria-label={tone.verb} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2 min-w-0">
              <span className="text-[13px] font-medium text-ink truncate">{title}</span>
              {sub && <span className="text-[11px] text-ink-muted/80 truncate min-w-0 hidden sm:inline">{sub}</span>}
            </span>
            {summary && <span className="block mt-0.5">{summary}</span>}
          </span>
        </button>
        {badges && <span className="shrink-0 flex items-center gap-1 pt-0.5">{badges}</span>}
        {actions && (
          <span className="shrink-0 flex items-center gap-0.5 pt-0.5 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 motion-safe:transition-opacity">
            {actions}
          </span>
        )}
      </div>
      {footer}
      {open && children && (
        <div id={regionId} role="region" aria-labelledby={id} className="pl-10 pr-3 pb-3 pt-0.5">
          {children(level)}
        </div>
      )}
    </div>
  )
})
