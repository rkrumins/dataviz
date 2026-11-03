/**
 * SubsetsChangeNote — said before a view's layers or scope are saved: the subset
 * views made from it change too ("This also changes 12 subset views made from
 * this view."). Nothing while the preview is off or the view has none.
 */
import { useQuery } from '@tanstack/react-query'
import { ListFilter } from 'lucide-react'

import { cn } from '@/lib/utils'
import { listSubsets, SUBSETS_QUERY_KEY } from '@/services/searchViewsApi'
import { useFeature } from '@/store/features'

import { subsetsWarning } from './model'

export function SubsetsChangeNote({ viewId, className }: { viewId: string; className?: string }) {
  const enabled = useFeature('searchViewsEnabled')
  const { data } = useQuery({
    queryKey: [SUBSETS_QUERY_KEY, viewId],
    queryFn: () => listSubsets(viewId),
    enabled,
    staleTime: 30_000,
  })
  const note = enabled ? subsetsWarning(data?.count ?? 0, 'change') : null
  if (!note) return null
  return (
    <div role="note" className={cn(
      'flex items-start gap-2.5 px-4 py-3 rounded-xl bg-amber-50 dark:bg-amber-500/[0.08] border border-amber-200 dark:border-amber-500/20',
      className,
    )}>
      <ListFilter className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" aria-hidden />
      <span className="text-xs font-medium text-amber-700 dark:text-amber-400">{note}</span>
    </div>
  )
}
