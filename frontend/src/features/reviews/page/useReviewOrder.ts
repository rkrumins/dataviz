/**
 * useReviewOrder — a review's changes in the order the keys step through them: every kind, as the
 * server lists them, read a page at a time — with each change's decision where the review is
 * decided change by change. Stepping past the last change read asks for the next page.
 */
import { useCallback, useMemo } from 'react'
import type { ChangeListOrigin, ChangeListRow } from '@/services/versioningApiService'
import { useChangeEntries } from '@/features/versioning/hooks/useVersioning'
import { useReviewChanges } from '../decisions/useReviewDecisions'

export function useReviewOrder({ wsId, prId, source, withDecisions }: {
  wsId: string
  prId: string
  /** Where the changes are listed; none: they are not listed here (a fork's review in a tree). */
  source: { graphId: string; origin: ChangeListOrigin } | null
  /** List them with their decisions (a draft's review, open). */
  withDecisions: boolean
}) {
  const reviewQ = useReviewChanges(wsId, prId, {}, !!source && withDecisions, true)
  const plainQ = useChangeEntries(wsId, source?.graphId, source?.origin, {}, { enabled: !!source && !withDecisions, summary: true })
  // The same rows either way; a review's carry their decisions (`ReviewChangeRow`).
  const q = (withDecisions ? reviewQ : plainQ) as unknown as typeof plainQ
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.entries) ?? [], [q.data])
  const byId = useMemo(() => new Map(rows.map((r) => [r.entityId, r])), [rows])
  const indexOf = useMemo(() => new Map(rows.map((r, i) => [r.entityId, i])), [rows])
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q

  /** The change before or after `from` (the first, from none); past the last read, the next page. */
  const step = useCallback((from: string | null, dir: 1 | -1): ChangeListRow | null => {
    const at = from !== null ? indexOf.get(from) ?? -1 : -1
    const to = at === -1 ? (dir > 0 ? 0 : -1) : at + dir
    if (to >= rows.length && hasNextPage && !isFetchingNextPage) void fetchNextPage()
    return rows[to] ?? null
  }, [rows, indexOf, hasNextPage, isFetchingNextPage, fetchNextPage])

  /** The next (or previous) change that `match`es after `from`, round to the start. */
  const seek = useCallback((from: string | null, dir: 1 | -1, match: (row: ChangeListRow) => boolean): ChangeListRow | null => {
    const n = rows.length
    const at = from !== null ? indexOf.get(from) ?? -1 : -1
    const base = at === -1 ? (dir > 0 ? -1 : n) : at
    for (let k = 1; k <= (at === -1 ? n : n - 1); k++) {
      const row = rows[(((base + dir * k) % n) + n) % n]
      if (match(row)) return row
    }
    return null
  }, [rows, indexOf])

  return { rows, byId, step, seek, isLoading: q.isLoading }
}
