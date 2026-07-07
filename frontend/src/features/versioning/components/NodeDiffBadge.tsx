/**
 * The single diff tint vocabulary — added / modified / removed. Reused by the
 * Changes panel rows, on-canvas node decoration, and (later) the commit timeline,
 * so the colour of "added" is defined in exactly one place.
 */
import { Plus, PenLine, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'
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
  },
  modified: {
    label: 'Modified',
    Icon: PenLine,
    text: 'text-amber-500',
    bg: 'bg-amber-500/5',
    border: 'border-amber-500/20',
    ring: 'ring-amber-500/50',
    accent: 'border-l-amber-500',
  },
  removed: {
    label: 'Removed',
    Icon: Minus,
    text: 'text-rose-500',
    bg: 'bg-rose-500/5',
    border: 'border-rose-500/20',
    ring: 'ring-rose-500/50',
    accent: 'border-l-rose-500',
  },
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
      {count != null && <span className="tabular-nums">{count}</span>}
    </span>
  )
}
