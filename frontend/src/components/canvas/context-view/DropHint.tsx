/**
 * What a drop will do, said while the drag hovers — every gesture says which kind it is. A DATA
 * change (the graph itself: an entity moved inside another) is a solid accent pill; a VIEW change
 * (only how this view arranges things) is an outlined, dashed one; a drop that can't happen says
 * why, muted, behind a lock. The surface it sits on mirrors it: a solid ring for data, a dashed
 * outline for the view (`dropSurfaceClass`, dropKind.ts).
 */
import { Eye, FolderInput, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DropKind } from './dropKind'

const PILL: Record<DropKind, string> = {
  data: 'bg-accent-lineage text-white shadow-[0_2px_10px_rgb(var(--nx-accent-lineage-rgb)_/_0.45)]',
  view: 'bg-canvas-elevated text-ink border border-dashed border-ink-muted/60 shadow-md shadow-black/10 dark:shadow-black/40',
  blocked: 'bg-canvas-elevated text-ink-muted border border-glass-border shadow-md shadow-black/10 dark:shadow-black/40',
}

const ICON = { data: FolderInput, view: Eye, blocked: Lock }

export function DropHint({ kind, title, detail, className }: {
  kind: DropKind
  /** What it does, naming where: "Move inside Finance". */
  title: string
  /** Which kind of change: "changes the data" / "only this view". None for a refusal. */
  detail?: string
  className?: string
}) {
  const Icon = ICON[kind]
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
      <Icon className={cn('w-3.5 h-3.5 flex-shrink-0', kind === 'blocked' && 'text-amber-600 dark:text-amber-400')} aria-hidden />
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
