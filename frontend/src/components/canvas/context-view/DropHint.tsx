/**
 * What a drop will do, said while the drag hovers — every gesture says which kind it is. A DATA
 * change (the graph itself: an entity moved inside another) is a solid accent pill; a VIEW change
 * (only how this view arranges things) is an outlined, dashed one; a drop that can't happen says
 * why, muted, behind a lock. The surface it sits on mirrors it: a solid ring for data, a dashed
 * outline for the view (`dropSurfaceClass`, dropKind.ts).
 *
 * `compact`, it is a tag in a line of text rather than a pill floating over a drag: `ChangeKindTag`
 * says a choice's kind beside it — in a menu, the move dialog, the drawer — in the same look.
 */
import { Eye, FolderInput, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DropKind } from './dropKind'
import { CHANGES_THE_DATA, NO_REACH, ONLY_THIS_VIEW, dataReachDetail, type DataReach } from './changeKind'

const PILL: Record<DropKind, string> = {
  data: 'bg-accent-lineage text-white shadow-[0_2px_10px_rgb(var(--nx-accent-lineage-rgb)_/_0.45)]',
  view: 'bg-canvas-elevated text-ink border border-dashed border-ink-muted/60 shadow-md shadow-black/10 dark:shadow-black/40',
  blocked: 'bg-canvas-elevated text-ink-muted border border-glass-border shadow-md shadow-black/10 dark:shadow-black/40',
}

const TAG: Record<DropKind, string> = {
  data: 'bg-accent-lineage text-white',
  view: 'text-ink-secondary border border-dashed border-ink-muted/60',
  blocked: 'text-ink-muted border border-glass-border',
}

const ICON = { data: FolderInput, view: Eye, blocked: Lock }

export function DropHint({ kind, title, detail, compact = false, className }: {
  kind: DropKind
  /** What it does, naming where: "Move inside Finance". */
  title: string
  /** Which kind of change: "changes the data" / "only this view". None for a refusal. */
  detail?: string
  /** A tag in a line, not a pill over a drag. */
  compact?: boolean
  className?: string
}) {
  const Icon = ICON[kind]
  const iconClass = cn('flex-shrink-0', kind === 'blocked' && 'text-amber-600 dark:text-amber-400')
  if (compact) {
    // A tag never hides its words: in a narrow menu it wraps.
    return (
      <span
        data-change-tag={kind}
        className={cn('inline-flex items-start gap-1 max-w-full rounded-md pl-1 pr-1.5 py-0.5 text-[10.5px] leading-[1.35] font-semibold', TAG[kind], className)}
      >
        <Icon className={cn('w-3 h-3 mt-px', iconClass)} aria-hidden />
        <span className="min-w-0">
          <span className="whitespace-nowrap">{title}</span>
          {detail && <><span aria-hidden className="opacity-50"> · </span><span className="font-medium opacity-90">{detail}</span></>}
        </span>
      </span>
    )
  }
  return (
    <span
      data-drop-hint={kind}
      className={cn(
        'pointer-events-none inline-flex items-center gap-1.5 max-w-full rounded-full pl-1.5 pr-2.5 py-1',
        'text-[11px] leading-none font-semibold whitespace-nowrap',
        PILL[kind],
        className,
      )}
    >
      <Icon className={cn('w-3.5 h-3.5', iconClass)} aria-hidden />
      <span className="truncate min-w-0">{title}</span>
      {detail && (
        <>
          <span aria-hidden className="opacity-50 flex-shrink-0">·</span>
          <span className="font-medium opacity-90 flex-shrink-0">{detail}</span>
        </>
      )}
    </span>
  )
}

/** A choice's kind, as a tag: "Changes the data · every view" (or the views it reaches), or "Only
 *  this view". */
export function ChangeKindTag({ kind, reach, className }: {
  kind: 'data' | 'view'
  /** Who a data change reaches. */
  reach?: DataReach
  className?: string
}) {
  return kind === 'data'
    ? <DropHint compact kind="data" title={CHANGES_THE_DATA} detail={dataReachDetail(reach ?? NO_REACH)} className={className} />
    : <DropHint compact kind="view" title={ONLY_THIS_VIEW} className={className} />
}
