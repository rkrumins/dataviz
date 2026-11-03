/**
 * SubsetIssueBanner — why a subset view's layers list no matches, said over the
 * canvas: the preview is off, this data source can't list them, or the view's
 * base view was deleted. Never an empty canvas left to explain itself.
 */
import * as LucideIcons from 'lucide-react'

export type SubsetIssue = 'off' | 'unsupported' | 'base_missing'

const WORDS: Record<SubsetIssue, { title: string; detail: string }> = {
  off: {
    title: 'Subset views are turned off',
    detail: 'This view shows a search’s matches, and the preview that lists them is off for this deployment. An administrator can turn it on under Administration → Features.',
  },
  unsupported: {
    title: 'This data source can’t list a subset view’s matches',
    detail: 'Subset views are read by the server’s search, which this data source doesn’t offer.',
  },
  base_missing: {
    title: 'Its base view was deleted',
    detail: 'This view shows a search’s matches inside another view, which has been deleted. Restore that view and this one shows its matches again.',
  },
}

export function SubsetIssueBanner({ issue }: { issue: SubsetIssue | null }) {
  if (!issue) return null
  const words = WORDS[issue]
  return (
    <div role="status" className="flex-none flex justify-center px-4 pt-3">
      <div className="flex max-w-[560px] gap-3 rounded-2xl border border-amber-500/30 bg-canvas-elevated/95 px-4 py-3 shadow-xl shadow-black/10 backdrop-blur">
        <LucideIcons.ListFilter className="mt-0.5 h-4 w-4 flex-none text-amber-600 dark:text-amber-400" aria-hidden />
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-ink">{words.title}</p>
          <p className="mt-0.5 text-[12px] leading-snug text-ink-muted">{words.detail}</p>
        </div>
      </div>
    </div>
  )
}
