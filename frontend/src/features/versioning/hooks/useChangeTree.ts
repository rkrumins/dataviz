/**
 * useChangeTree — a change list top-down, read a level at a time from the server's change tree
 * (`/diff/tree`; a draft review's `/merge-requests/{id}/tree`, each change with its decision).
 *
 * Each open container's level is a window of its children — from `start`, `pages` pages of
 * {@link TREE_PAGE} — so "Show more" reads one page, and revealing a change deep in a long level
 * reads the page it is on, not every page before it. Closing a container keeps what it read (the
 * query cache): opening it again is instant. Nothing here holds more than the rows open.
 */
import { useCallback, useMemo, useState } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import * as api from '@/services/versioningApiService'
import type { ChangeListOrigin, ChangeTreeItem, ChangeTreeLevel, ChangeTreePath } from '@/services/versioningApiService'
import { DECISION_KEYS } from '@/features/reviews/decisions/useReviewDecisions'
import { CHANGE_LIST_RETRY, VERSIONING_KEYS, changeListStale } from './useVersioning'

/** Rows a level reads at a time. */
export const TREE_PAGE = 100
/** The top of the tree, as a container. */
export const TOP = ''

export interface ChangeTreeSource {
  wsId: string
  graphId: string
  origin: ChangeListOrigin
  /** A draft's review: its tree, each change with its decision. */
  prId?: string | null
}

interface LevelWindow { start: number; pages: number }

/** A level as read so far: its children from `start`, in order, up to the first page not read yet. */
export interface TreeLevel {
  items: ChangeTreeItem[]
  start: number
  total: number | null
  loading: boolean
  error: boolean
  retry: () => void
}

export type TreeRow =
  | { kind: 'item'; key: string; depth: number; parent: string; item: ChangeTreeItem; posinset: number; setsize: number }
  | { kind: 'earlier'; key: string; depth: number; parent: string; count: number }
  | { kind: 'more'; key: string; depth: number; parent: string; count: number; left: number }
  | { kind: 'loading'; key: string; depth: number; parent: string }
  | { kind: 'error'; key: string; depth: number; parent: string; retry: () => void }

/** The rows as drawn: every open level under its container, depth first. O(rows read). */
export function flattenTree(levels: ReadonlyMap<string, TreeLevel>, open: ReadonlySet<string>): TreeRow[] {
  const out: TreeRow[] = []
  const walk = (parent: string, depth: number) => {
    const lv = levels.get(parent)
    if (!lv) { out.push({ kind: 'loading', key: `loading:${parent}`, depth, parent }); return }
    if (lv.start > 0 && lv.items.length) {
      out.push({ kind: 'earlier', key: `earlier:${parent}`, depth, parent, count: Math.min(TREE_PAGE, lv.start) })
    }
    lv.items.forEach((item, i) => {
      out.push({ kind: 'item', key: item.id, depth, parent, item, posinset: lv.start + i + 1, setsize: lv.total ?? lv.items.length })
      // A cycle in bad data cannot nest forever: the server stops a path at 64.
      if (item.hasChildren && open.has(item.id) && depth < 64) walk(item.id, depth + 1)
    })
    const read = lv.start + lv.items.length
    if (lv.error) out.push({ kind: 'error', key: `error:${parent}`, depth, parent, retry: lv.retry })
    else if (lv.loading) out.push({ kind: 'loading', key: `loading:${parent}`, depth, parent })
    else if (lv.total !== null && read < lv.total) {
      out.push({ kind: 'more', key: `more:${parent}`, depth, parent, count: Math.min(TREE_PAGE, lv.total - read), left: lv.total - read })
    }
  }
  walk(TOP, 0)
  return out
}

/** The window that holds position `at`: this one, one page longer, or the page it is on. */
function windowHolding(w: LevelWindow | undefined, at: number): LevelWindow {
  if (!w) return { start: Math.floor(at / TREE_PAGE) * TREE_PAGE, pages: 1 }
  if (at >= w.start && at < w.start + w.pages * TREE_PAGE) return w
  if (at >= w.start && at < w.start + (w.pages + 1) * TREE_PAGE) return { ...w, pages: w.pages + 1 }
  return { start: Math.floor(at / TREE_PAGE) * TREE_PAGE, pages: 1 }
}

export function useChangeTree(source: ChangeTreeSource, enabled = true) {
  const { wsId, graphId, origin, prId } = source
  const qc = useQueryClient()
  const [windows, setWindows] = useState<ReadonlyMap<string, LevelWindow>>(() => new Map([[TOP, { start: 0, pages: 1 }]]))
  const [open, setOpenSet] = useState<ReadonlySet<string>>(() => new Set())

  const keyOf = useCallback((parent: string, offset: number) => (prId
    ? DECISION_KEYS.tree(wsId, prId, parent, offset)
    : [...VERSIONING_KEYS.changeList(wsId, graphId, origin), 'tree', parent, offset]), [wsId, graphId, origin, prId])
  const read = useCallback((parent: string, offset: number) => (prId
    ? api.getReviewChangeTreeLevel(wsId, prId, parent || null, offset, TREE_PAGE, true)
    : api.getChangeTreeLevel(wsId, graphId, origin, parent || null, offset, TREE_PAGE, true)), [wsId, graphId, origin, prId])

  // The pages every open level wants (the top always open).
  const wanted = useMemo(() => {
    const out: Array<{ parent: string; offset: number }> = []
    for (const [parent, w] of windows) {
      if (parent !== TOP && !open.has(parent)) continue
      for (let i = 0; i < w.pages; i++) out.push({ parent, offset: w.start + i * TREE_PAGE })
    }
    return out
  }, [windows, open])

  const combine = useCallback((results: Array<{ data?: ChangeTreeLevel; isError: boolean; refetch: () => unknown }>) => {
    const acc = new Map<string, { lv: TreeLevel; failed: Array<() => unknown>; stopped: boolean }>()
    results.forEach((r, i) => {
      const { parent, offset } = wanted[i]
      let a = acc.get(parent)
      if (!a) {
        const failed: Array<() => unknown> = []
        a = { failed, stopped: false, lv: {
          items: [], start: offset, total: null, loading: false, error: false,
          retry: () => { for (const f of failed) void f() },
        } }
        acc.set(parent, a)
      }
      if (r.data) a.lv.total = r.data.total
      else if (r.isError) { a.lv.error = true; a.failed.push(r.refetch) }
      else a.lv.loading = true
      // In order up to the first page not read yet: never a gap in a level.
      if (a.stopped) return
      if (r.data) a.lv.items.push(...r.data.items)
      else a.stopped = true
    })
    return new Map([...acc].map(([k, a]) => [k, a.lv]))
  }, [wanted])

  const levels = useQueries({
    queries: wanted.map(({ parent, offset }) => ({
      queryKey: keyOf(parent, offset),
      queryFn: () => read(parent, offset),
      enabled: enabled && !!wsId && !!graphId,
      staleTime: changeListStale(origin),
      ...CHANGE_LIST_RETRY,
    })),
    combine,
  })
  const rows = useMemo(() => flattenTree(levels, open), [levels, open])

  const setOpen = useCallback((id: string, on: boolean) => {
    setOpenSet((prev) => {
      if (prev.has(id) === on) return prev
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
    if (on) setWindows((prev) => (prev.has(id) ? prev : new Map(prev).set(id, { start: 0, pages: 1 })))
  }, [])
  const more = useCallback((parent: string) => setWindows((prev) => {
    const w = prev.get(parent) ?? { start: 0, pages: 1 }
    return new Map(prev).set(parent, { ...w, pages: w.pages + 1 })
  }), [])
  const earlier = useCallback((parent: string) => setWindows((prev) => {
    const w = prev.get(parent) ?? { start: 0, pages: 1 }
    if (w.start === 0) return prev
    return new Map(prev).set(parent, { start: Math.max(0, w.start - TREE_PAGE), pages: w.pages + 1 })
  }), [])
  const collapseAll = useCallback(() => setOpenSet(new Set()), [])

  /** Open the way down to a change, each level at the page it is on. */
  const reveal = useCallback((p: ChangeTreePath) => {
    const chain = [TOP, ...p.path.map((x) => x.id)]
    const at = [...p.path.map((x) => x.at), p.at]
    setWindows((prev) => {
      const next = new Map(prev)
      chain.forEach((parent, i) => { next.set(parent, windowHolding(next.get(parent), at[i] ?? 0)) })
      return next
    })
    setOpenSet((prev) => {
      const next = new Set(prev)
      for (const x of p.path) next.add(x.id)
      return next
    })
  }, [])
  /** Where a change sits (cached with its list). */
  const pathOf = useCallback((entityId: string) => qc.fetchQuery({
    queryKey: [...VERSIONING_KEYS.changeList(wsId, graphId, origin), 'treePath', entityId],
    queryFn: () => api.getChangeTreePath(wsId, graphId, origin, entityId),
    staleTime: changeListStale(origin),
  }), [qc, wsId, graphId, origin])

  return { rows, levels, open, setOpen, more, earlier, collapseAll, reveal, pathOf }
}
