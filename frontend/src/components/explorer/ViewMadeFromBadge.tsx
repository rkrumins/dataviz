/**
 * The "Auto-updating" / "Snapshot" / "Subset" mark on a view's Explorer card and preview: what the
 * view is made from (see ./madeFrom). A card says it from the view's config alone; the preview,
 * which reads how its one view stands, hands in fuller words ("Auto-updating · 1,234 members",
 * "Subset of Payments"). Renders nothing for any other view.
 */
import { ListFilter, RefreshCw, Snowflake } from 'lucide-react'

import { HoverTip } from '@/components/ui/HoverTip'
import { cn } from '@/lib/utils'

import { madeFromWords, type MadeFrom } from './madeFrom'

export function ViewMadeFromBadge({ madeFrom, label, compact, className }: {
  madeFrom: MadeFrom | null
  /** Fuller words than the config alone gives, once read (the preview). */
  label?: string
  /** Glyph only — for compact density, where the word doesn't fit. */
  compact?: boolean
  className?: string
}) {
  if (!madeFrom) return null
  const words = madeFromWords(madeFrom)
  const Icon = madeFrom.kind === 'subset' ? ListFilter : madeFrom.mode === 'live' ? RefreshCw : Snowflake
  const text = label ?? words.label
  return (
    <HoverTip label={words.tip} detail={words.detail}>
      <span
        data-made-from={madeFrom.kind}
        className={cn('inline-flex items-center gap-1 text-[10px] font-medium leading-none text-accent-lineage', className)}
      >
        <Icon className="h-2.5 w-2.5 shrink-0" aria-hidden />
        {compact ? <span className="sr-only">{text}</span> : text}
      </span>
    </HoverTip>
  )
}
