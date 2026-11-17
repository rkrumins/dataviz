/**
 * The single diff tint vocabulary — added / modified / removed. Reused by the
 * Changes panel rows, on-canvas node decoration, and the commit timeline. Its
 * colours are the tree's (`changeTone`): green, orange, rose.
 */
import { Plus, PenLine, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChangeStatus } from '../model/changeModel'
import { CHANGE_TONE } from '../model/changeTone'

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
  added: { label: 'Added', Icon: Plus, text: CHANGE_TONE.added.text, bg: CHANGE_TONE.added.soft,
    border: CHANGE_TONE.added.border, ring: CHANGE_TONE.added.ring, accent: CHANGE_TONE.added.accent },
  modified: { label: 'Modified', Icon: PenLine, text: CHANGE_TONE.modified.text, bg: CHANGE_TONE.modified.soft,
    border: CHANGE_TONE.modified.border, ring: CHANGE_TONE.modified.ring, accent: CHANGE_TONE.modified.accent },
  removed: { label: 'Removed', Icon: Minus, text: CHANGE_TONE.removed.text, bg: CHANGE_TONE.removed.soft,
    border: CHANGE_TONE.removed.border, ring: CHANGE_TONE.removed.ring, accent: CHANGE_TONE.removed.accent },
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
