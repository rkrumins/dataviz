/**
 * NarrowRowMark — on a narrowed canvas, why a row is there.
 *
 * A collapsed container says how many of the narrowing's entities are inside it
 * (expanding shows them); a source or consumer says how many steps it is from the
 * starting points; a starting point is marked as one. Rows in scope for any other
 * reason — inside a starting point, inside a source — need no word. Nothing at
 * all on a canvas that is not narrowed: each row reads only its own answer.
 */
import * as LucideIcons from 'lucide-react'

import { HoverTip } from '@/components/ui/HoverTip'
import { cn } from '@/lib/utils'

import { useNarrowInside, useNarrowMember } from './narrowStore'

const PILL = 'inline-flex items-center gap-1 h-6 px-1.5 rounded-lg text-[11px] font-semibold tabular-nums flex-shrink-0'

export function NarrowRowMark({ urn, collapsed }: { urn: string; collapsed: boolean }) {
  const member = useNarrowMember(urn)
  const inside = useNarrowInside(urn)

  if (collapsed && inside > 0) {
    return (
      <HoverTip
        className="flex"
        label={`${inside.toLocaleString()} of the narrowed canvas ${inside === 1 ? 'is' : 'are'} inside`}
        detail="Expand to see them."
      >
        <span className={cn(PILL, 'bg-accent-lineage/10 text-accent-lineage border border-accent-lineage/25')}>
          <LucideIcons.ScanSearch className="w-3 h-3" aria-hidden="true" />
          {inside.toLocaleString()}
        </span>
      </HoverTip>
    )
  }
  if (member?.via === 'upstream' || member?.via === 'downstream') {
    const up = member.via === 'upstream'
    const hops = member.hops ?? 1
    const Arrow = up ? LucideIcons.ArrowUpLeft : LucideIcons.ArrowDownRight
    return (
      <HoverTip
        className="flex"
        label={up ? 'Feeds the starting points' : 'Fed by the starting points'}
        detail={`${hops.toLocaleString()} ${hops === 1 ? 'step' : 'steps'} ${up ? 'upstream' : 'downstream'}.`}
      >
        <span className={cn(PILL, up ? 'text-lineage-in bg-lineage-in/10' : 'text-lineage-out bg-lineage-out/10')}>
          <Arrow className="w-3 h-3" strokeWidth={2.4} aria-hidden="true" />
          {hops}
        </span>
      </HoverTip>
    )
  }
  if (member?.via === 'seed') {
    return (
      <HoverTip className="flex" label="A starting point of the narrowing">
        <span className={cn(PILL, 'px-1 text-accent-lineage')} aria-label="A starting point">
          <LucideIcons.Crosshair className="w-3.5 h-3.5" aria-hidden="true" />
        </span>
      </HoverTip>
    )
  }
  return null
}
