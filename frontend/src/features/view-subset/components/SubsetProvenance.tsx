/**
 * SubsetProvenance — "Subset of ‹Source›" on a subset view's identity line.
 *
 * The source is named — and linked — only when the reader can open it; the
 * server withholds the name otherwise, and the line says as much rather than
 * pointing at something that would refuse them.
 */
import { Link } from 'react-router-dom'
import { ScissorsLineDashed } from 'lucide-react'

import { HoverTip } from '@/components/ui/HoverTip'
import type { ViewDerivedFrom } from '@/services/viewApiService'

export function SubsetProvenance({ derivedFrom, itemClassName, linkClassName }: {
  derivedFrom: ViewDerivedFrom
  itemClassName: string
  linkClassName: string
}) {
  if (derivedFrom.accessible && derivedFrom.name) {
    return (
      <HoverTip
        className={`${itemClassName} min-w-0`}
        label={`Open ${derivedFrom.name}, the view this subset was made from`}
        detail="Lineage this subset leaves out is still there"
      >
        <Link
          to={`/views/${derivedFrom.id}`}
          aria-label={`Subset of ${derivedFrom.name}`}
          className={`${itemClassName} ${linkClassName}`}
        >
          <ScissorsLineDashed className="h-3 w-3 shrink-0 text-accent-explore" aria-hidden />
          <span className="truncate">Subset of {derivedFrom.name}</span>
        </Link>
      </HoverTip>
    )
  }
  return (
    <HoverTip
      className={`${itemClassName} min-w-0`}
      label="Made from a view you can't open"
      detail="Its owner has not shared it with you"
    >
      <span className={itemClassName}>
        <ScissorsLineDashed className="h-3 w-3 shrink-0 text-accent-explore" aria-hidden />
        <span className="truncate">Subset of a view you can&apos;t open</span>
      </span>
    </HoverTip>
  )
}
