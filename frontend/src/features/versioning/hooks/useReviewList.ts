/**
 * useReviewList — the list a review goes through, as narrowed: its scope, the scope's summary, the
 * kind listed, and the filter the rows are asked for with. The rail and the navigator both read it,
 * so they ask for the same pages (one query, shared) and go through the same changes in the same
 * order. Nothing is fetched while no review is open.
 */
import { useMemo } from 'react'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import type { ChangeListFilter, ChangeListKind } from '@/services/versioningApiService'
import { useReviewStore } from '@/store/reviewStore'
import { kindsOf } from '../model/changeListSummary'
import { useChangeEntries, useChangeSummary } from './useVersioning'
import { useChangesScope } from './useChangesScope'

export function useReviewList(viewId: string | null) {
  const { wsId, graphId, options, current } = useChangesScope(viewId)
  const reviewing = useReviewStore((s) => s.navigatorOpen || s.listOpen)
  const operation = useReviewStore((s) => s.operation)
  const filter = useReviewStore((s) => s.filter)
  const summaryQ = useChangeSummary(wsId ?? undefined, graphId, reviewing ? current?.origin : null)
  const s = summaryQ.data ?? null
  const kinds = useMemo(() => (s ? kindsOf(s) : []), [s])
  const kind: ChangeListKind | undefined = filter.kind && kinds.includes(filter.kind) ? filter.kind : kinds[0]
  // Asked for once the typing settles.
  const q = useDebouncedValue(filter.q ?? '', 250)
  const rowsFilter: ChangeListFilter = useMemo(
    () => ({ kind, statuses: operation ? [operation] : [], type: filter.type || undefined, q }),
    [kind, operation, filter.type, q],
  )
  return { wsId, graphId, options, current, summaryQ, s, kinds, kind, rowsFilter }
}

/** The rows of a review's list, a page at a time: the same pages `ChangeRows` draws. */
export function useReviewRows(list: ReturnType<typeof useReviewList>) {
  const { wsId, graphId, current, s, kind, rowsFilter } = list
  const q = useChangeEntries(wsId ?? undefined, graphId, current?.origin, rowsFilter, {
    enabled: !!s && s.listed > 0 && !!kind,
  })
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.entries) ?? [], [q.data])
  return { ...q, rows, matching: q.data?.pages[0]?.total ?? 0 }
}
