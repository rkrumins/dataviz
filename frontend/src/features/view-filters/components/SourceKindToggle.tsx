/**
 * Versioned / External — two pills that narrow the list to views whose graph is
 * versioned here, or mastered by another system.
 *
 * Pills, not a dropdown: there are only two answers and both should be visible
 * without a click. Pressing the active pill again lets go of the filter, so there
 * is no third "Any" pill taking space. The words, icons and tones are the ones the
 * sync-status chip already uses for the same distinction, and the hover text is
 * its explainer — a person who learns "Versioned" here has learnt it everywhere.
 *
 * Hidden when version control is switched off for the deployment: every
 * version-control surface goes with it.
 */
import { cn } from '@/lib/utils'
import { useFeature } from '@/store/features'
import { HoverTip } from '@/components/ui/HoverTip'
import { KIND_TEXT } from '@/features/sync-status/deriveSync'
import type { SourceKind } from '../model'
import { SOURCE_KIND_LABELS } from '../dimensions'
import { SOURCE_KIND_META } from '../sourceKindMeta'

export function SourceKindToggle({ value, onChange, counts, className }: {
  value: SourceKind | null
  onChange: (next: SourceKind | null) => void
  /** Views each pill would show, given the other filters. */
  counts?: Partial<Record<SourceKind, number>> | null
  className?: string
}) {
  const enabled = useFeature('versioningEnabled')
  if (!enabled) return null

  return (
    <div
      role="group"
      aria-label="Versioned or external graphs"
      className={cn('inline-flex items-center gap-0.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.05] p-0.5', className)}
    >
      {(['versioned', 'external'] as const).map(kind => {
        const meta = SOURCE_KIND_META[kind]
        const Icon = meta.icon
        const on = value === kind
        const count = counts?.[kind]
        return (
          <HoverTip
            key={kind}
            label={on ? `Showing ${KIND_TEXT[kind].label.toLowerCase()}s only — click to show all` : `Show views on ${KIND_TEXT[kind].label.toLowerCase()}s`}
            detail={KIND_TEXT[kind].explainer}
          >
            <button
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? null : kind)}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium',
                'transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                on ? cn(meta.active, 'bg-canvas-elevated shadow-sm') : 'border-transparent text-ink-muted hover:text-ink',
              )}
            >
              <Icon className={cn('h-3 w-3', on ? '' : meta.glyph)} aria-hidden />
              {SOURCE_KIND_LABELS[kind]}
              {count !== undefined && (
                <span className={cn('tabular-nums text-[10px] font-semibold', on ? '' : 'text-ink-muted', count === 0 && 'opacity-50')}>
                  {count.toLocaleString()}
                </span>
              )}
            </button>
          </HoverTip>
        )
      })}
    </div>
  )
}
