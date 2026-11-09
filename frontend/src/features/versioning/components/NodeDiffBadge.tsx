/**
 * The single diff tint vocabulary — added / modified / removed. Reused by the
 * Changes panel rows, on-canvas node decoration, and (later) the commit timeline,
 * so the colour of "added" is defined in exactly one place.
 *
 * A deleted entity reads the same everywhere — a card, a row, a list, the drawer: its name struck
 * through (`STATUS_META.removed.strike`) and a quiet {@link DeletedChip}. Never colour alone.
 */
import { Plus, PenLine, Minus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import type { ChangeStatus } from '../model/changeModel'

interface StatusMeta {
  label: string
  Icon: React.ComponentType<{ className?: string }>
  /** Foreground text/icon colour. */
  text: string
  /** Soft fill + hairline border (panel sections, chips). */
  bg: string
  border: string
  /** On-canvas ring + left accent (node decoration). */
  ring: string
  accent: string
  /** On a name: struck through for a deletion, nothing otherwise. */
  strike: string
}

export const STATUS_META: Record<ChangeStatus, StatusMeta> = {
  added: {
    label: 'Added',
    Icon: Plus,
    text: 'text-emerald-500',
    bg: 'bg-emerald-500/5',
    border: 'border-emerald-500/20',
    ring: 'ring-emerald-500/50',
    accent: 'border-l-emerald-500',
    strike: '',
  },
  modified: {
    label: 'Modified',
    Icon: PenLine,
    text: 'text-amber-500',
    bg: 'bg-amber-500/5',
    border: 'border-amber-500/20',
    ring: 'ring-amber-500/50',
    accent: 'border-l-amber-500',
    strike: '',
  },
  removed: {
    label: 'Deleted',
    Icon: Minus,
    text: 'text-rose-500',
    bg: 'bg-rose-500/5',
    border: 'border-rose-500/20',
    ring: 'ring-rose-500/50',
    accent: 'border-l-rose-500',
    strike: 'line-through decoration-rose-400/80 decoration-2',
  },
}

/** What marks a deleted entity on a card, a row or the drawer, beside its struck name: the word
 *  and a bin, quiet. `title` says which deletion (not saved yet, in this draft…); `compact` keeps
 *  the bin alone, the word left to screen readers. */
export function DeletedChip({ title, compact = false, className }: {
  title?: string
  compact?: boolean
  className?: string
}) {
  const chip = (
    <span className={cn(
      'inline-flex items-center gap-1 shrink-0 rounded px-1 py-px text-[10px] font-semibold uppercase tracking-wide',
      'text-rose-600 dark:text-rose-400 bg-rose-500/10 ring-1 ring-inset ring-rose-500/20',
      className,
    )}>
      <Trash2 className="w-2.5 h-2.5" aria-hidden />
      {compact ? <span className="sr-only">Deleted</span> : 'Deleted'}
    </span>
  )
  return title ? <HoverTip className="inline-flex shrink-0" label={title}>{chip}</HoverTip> : chip
}

/** A small status chip: glyph + (optional) count. Used inline and in section headers. */
export function NodeDiffBadge({
  status,
  count,
  withLabel = false,
  className,
}: {
  status: ChangeStatus
  count?: number
  withLabel?: boolean
  className?: string
}) {
  const meta = STATUS_META[status]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium',
        meta.bg,
        meta.border,
        meta.text,
        className,
      )}
    >
      <meta.Icon className="w-3 h-3" />
      {withLabel && <span>{meta.label}</span>}
      {count != null && <span className="tabular-nums">{count.toLocaleString()}</span>}
    </span>
  )
}
