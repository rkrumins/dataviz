/**
 * Marks a card — or the Anchor Rail entry for an end scrolled away — as an end of the line the
 * relationship drawer is open on, in the drawer's own words.
 */
import { cn } from '@/lib/utils'
import type { LineEnd } from './lineEnd'

const LABEL: Record<LineEnd, string> = { from: 'From', to: 'To', twoWay: 'Two-way' }

export function LineEndTag({ end, className }: { end: LineEnd; className?: string }) {
  return (
    <span
      data-line-end={end}
      className={cn(
        'inline-flex items-center px-1.5 py-px rounded text-[10px] font-semibold uppercase tracking-wide',
        'bg-accent-lineage/10 text-accent-lineage',
        className,
      )}
    >
      {LABEL[end]}
    </span>
  )
}
