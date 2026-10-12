/**
 * The Versioned / External mark on a view's card and list row — the same fact the
 * filter pills select on, so a person can see why a view is (or isn't) in a
 * filtered list without opening it.
 *
 * Nothing renders when the kind is unknown (the server couldn't reach the version
 * store, or the view has no data source to judge): an absent fact is left out, not
 * guessed. Hidden with the rest of version control when that's switched off.
 */
import { cn } from '@/lib/utils'
import { useFeature } from '@/store/features'
import { HoverTip } from '@/components/ui/HoverTip'
import { KIND_TEXT } from '@/features/sync-status/deriveSync'
import type { SourceKind } from '../model'
import { SOURCE_KIND_LABELS } from '../dimensions'
import { SOURCE_KIND_META } from '../sourceKindMeta'

export function SourceKindBadge({ kind, compact, className }: {
  kind?: SourceKind | null
  /** Glyph only — for compact density, where the word doesn't fit. */
  compact?: boolean
  className?: string
}) {
  const enabled = useFeature('versioningEnabled')
  if (!enabled || !kind) return null
  const meta = SOURCE_KIND_META[kind]
  const Icon = meta.icon
  return (
    <HoverTip label={KIND_TEXT[kind].label} detail={KIND_TEXT[kind].explainer}>
      <span
        data-source-kind={kind}
        className={cn(
          'inline-flex items-center gap-1 text-[10px] font-medium leading-none',
          compact ? meta.glyph : 'text-ink-muted',
          className,
        )}
      >
        <Icon className={cn('h-2.5 w-2.5 shrink-0', meta.glyph)} aria-hidden />
        {compact ? <span className="sr-only">{SOURCE_KIND_LABELS[kind]}</span> : SOURCE_KIND_LABELS[kind]}
      </span>
    </HoverTip>
  )
}
