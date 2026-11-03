/**
 * NarrowChip — the canvas says it is narrowed, and how to change that.
 *
 * A canvas showing part of a view must never pass for the whole of it: the chip
 * stays at the top for as long as the narrowing does, naming how many entities
 * it shows and what they are, with every limit the answer reached. From it the
 * narrowing can be changed, handed to someone else as a link, or put away.
 */
import { useState } from 'react'
import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'

import { HoverTip } from '@/components/ui/HoverTip'
import { MOTION } from '@/lib/motion'
import { cn } from '@/lib/utils'

import { canRetry, describeNarrow, truncationNotes } from './model'
import type { AppliedNarrow } from './narrowStore'

export interface NarrowChipProps {
  applied: AppliedNarrow
  onEdit: () => void
  onClear: () => void
  /** The narrowing as a link; absent when it is too big to carry in one. */
  link?: () => string
  /** Ask again — offered when the answer was cut short. */
  onRetry?: () => void
}

const quiet = cn(
  'pointer-events-auto inline-flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11.5px] font-semibold',
  'text-ink-secondary hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.07] transition-colors',
)

/** What each part of the reach added, in words. */
function breakdown(applied: AppliedNarrow): string {
  const c = applied.result.counts
  const parts = [
    `${c.seeds.toLocaleString()} ${c.seeds === 1 ? 'starting point' : 'starting points'}`,
    c.inside === null ? 'everything inside them' : c.inside ? `${c.inside.toLocaleString()} inside them` : '',
    c.upstream ? `${c.upstream.toLocaleString()} upstream` : '',
    c.downstream ? `${c.downstream.toLocaleString()} downstream` : '',
    c.partnerInside === null ? 'everything inside those' : c.partnerInside ? `${c.partnerInside.toLocaleString()} inside those` : '',
  ]
  return parts.filter(Boolean).join(' · ')
}

export function NarrowChip({ applied, onEdit, onClear, link, onRetry }: NarrowChipProps) {
  const [copied, setCopied] = useState(false)
  const total = applied.result.counts.total
  const notes = truncationNotes(applied.result)
  const sentence = describeNarrow(applied.spec, applied.seedsLabel)

  const copy = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link())
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* the clipboard refused: nothing to undo */
    }
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-4">
      <motion.div
        role="status"
        aria-label="The canvas is narrowed"
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={MOTION.modalSpring}
        className={cn(
          'pointer-events-auto flex items-center gap-3 w-full min-w-0 max-w-[640px]',
          'pl-3 pr-2 py-2 rounded-2xl backdrop-blur-xl',
          'bg-white/85 dark:bg-neutral-900/85',
          'ring-1 ring-accent-lineage/30',
          'shadow-xl shadow-black/[0.08] dark:shadow-black/50',
        )}
      >
        <span className="flex-none grid place-items-center w-7 h-7 rounded-full bg-accent-lineage/10 text-accent-lineage" aria-hidden="true">
          <LucideIcons.ScanSearch className="w-3.5 h-3.5" />
        </span>
        <HoverTip className="flex-1 min-w-0 flex" label={`Showing ${sentence}`} detail={breakdown(applied)}>
          <span className="min-w-0">
            <span className="block font-display text-[12.5px] text-ink leading-tight truncate">
              Narrowed to <strong className="font-semibold tabular-nums">{total.toLocaleString()}</strong> {total === 1 ? 'entity' : 'entities'}
            </span>
            <span className="block mt-0.5 text-[10.5px] text-ink-muted leading-tight truncate">{sentence}</span>
          </span>
        </HoverTip>
        {notes.length > 0 && (
          <HoverTip className="flex" label="Not everything it reaches is shown" detail={notes.join(' ')}>
            <span className="grid place-items-center w-7 h-7 rounded-lg text-amber-600 dark:text-amber-400" aria-label="Not everything it reaches is shown">
              <LucideIcons.TriangleAlert className="w-3.5 h-3.5" />
            </span>
          </HoverTip>
        )}
        <span className="flex items-center gap-0.5 flex-none">
          {onRetry && canRetry(applied.result) && (
            <button type="button" onClick={onRetry} className={quiet}>
              <LucideIcons.RotateCw className="w-3 h-3" aria-hidden="true" />
              Try again
            </button>
          )}
          <button type="button" onClick={onEdit} className={quiet}>
            <LucideIcons.SlidersHorizontal className="w-3 h-3" aria-hidden="true" />
            Edit
          </button>
          <HoverTip
            className="flex"
            label={link ? 'Copy a link to this narrowing' : 'Too many starting points for a link'}
            detail={link ? 'It opens the view narrowed the same way, on the data as it is then.' : 'Narrow from a search instead: a link carries the search.'}
          >
            <button type="button" onClick={copy} disabled={!link} className={cn(quiet, 'disabled:opacity-40 disabled:pointer-events-none')} aria-label="Copy link">
              {copied ? <LucideIcons.Check className="w-3 h-3 text-emerald-500" /> : <LucideIcons.Link className="w-3 h-3" />}
              {copied ? 'Copied' : 'Link'}
            </button>
          </HoverTip>
          <button
            type="button"
            onClick={onClear}
            className={cn(quiet, 'text-accent-lineage hover:text-accent-lineage hover:bg-accent-lineage/10')}
          >
            <LucideIcons.X className="w-3 h-3" aria-hidden="true" />
            Show everything
          </button>
        </span>
      </motion.div>
    </div>
  )
}
