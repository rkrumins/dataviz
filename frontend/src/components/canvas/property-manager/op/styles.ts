/** The dialog's field and label styles. */
import { cn } from '@/lib/utils'

export const FIELD = cn(
  'w-full h-10 px-3 rounded-lg text-sm text-ink outline-none transition-colors',
  'bg-black/[0.03] dark:bg-white/[0.04] border border-black/[0.08] dark:border-white/[0.10]',
  'placeholder:text-ink-muted/70 focus-visible:border-accent-lineage/50 focus-visible:ring-2 focus-visible:ring-accent-lineage/20',
)
export const LABEL = 'block text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted mb-1.5'
/** A secondary button's edge, seen on a light surface too — the glass border is white glass. */
export const SECONDARY_EDGE = 'border-black/[0.10] dark:border-white/[0.10]'
