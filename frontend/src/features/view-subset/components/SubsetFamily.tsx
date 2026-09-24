/**
 * SubsetFamily — a view's place among its subsets, in Details › About: the
 * view it was made from (when it is a subset), and the subsets made from it.
 *
 * The list is asked for only when the sheet opens, and is the ordinary view
 * list filtered to this source — so it holds exactly the subsets the reader
 * could open anyway, and never names one they could not.
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ChevronRight, ScissorsLineDashed } from 'lucide-react'

import { listViews, type View } from '@/services/viewApiService'

import { SUBSET_FAMILY_PAGE } from '../model/limits'

export function SubsetFamily({ view }: { view: View }) {
  const { data, status } = useQuery({
    queryKey: ['views', 'subsets-of', view.id],
    queryFn: ({ signal }) => listViews({ derivedFrom: view.id, limit: SUBSET_FAMILY_PAGE, sort: 'newest' }, signal),
    enabled: view.viewType === 'reference',
    staleTime: 60_000,
  })
  const subsets = data?.items ?? []
  const from = view.derivedFrom

  if (!from && (status !== 'success' || subsets.length === 0)) return null

  return (
    <section aria-label="Subsets" className="mt-5 space-y-3">
      <h3 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-ink-muted">
        <ScissorsLineDashed className="w-3.5 h-3.5 text-accent-explore" aria-hidden />
        Subsets
      </h3>

      {from && (
        <div className="rounded-xl border border-black/[0.08] dark:border-white/[0.08] px-3 py-2.5">
          <p className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted">Made from</p>
          {from.accessible && from.name ? (
            <Link
              to={`/views/${from.id}`}
              className="mt-0.5 inline-flex items-center gap-1 text-[13px] font-medium text-ink hover:text-accent-explore transition-colors"
            >
              {from.name}
              <ChevronRight className="w-3.5 h-3.5 text-ink-muted" aria-hidden />
            </Link>
          ) : (
            <p className="mt-0.5 text-[13px] text-ink-secondary">A view you can&apos;t open</p>
          )}
          <p className="mt-0.5 text-[11.5px] text-ink-muted">
            This view shows part of it; lineage through what it leaves out draws as virtual hops.
          </p>
        </div>
      )}

      {subsets.length > 0 && (
        <div>
          <p className="pb-1.5 text-[11.5px] text-ink-secondary">
            {data!.total.toLocaleString()} {data!.total === 1 ? 'subset was' : 'subsets were'} made from this view
          </p>
          <ul className="rounded-xl border border-black/[0.08] dark:border-white/[0.08] divide-y divide-black/[0.06] dark:divide-white/[0.06] overflow-hidden">
            {subsets.map(s => (
              <li key={s.id}>
                <Link
                  to={`/views/${s.id}`}
                  className="flex items-center gap-2 px-3 py-2 min-w-0 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors"
                >
                  <span className="truncate text-[12.5px] font-medium text-ink">{s.name}</span>
                  {s.createdByName && <span className="flex-shrink-0 text-[11px] text-ink-muted">by {s.createdByName}</span>}
                  <ChevronRight className="ml-auto w-3.5 h-3.5 flex-shrink-0 text-ink-muted" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
          {data!.hasMore && (
            <p className="pt-1 text-[11px] text-ink-muted">Showing the {subsets.length} newest.</p>
          )}
        </div>
      )}
    </section>
  )
}
