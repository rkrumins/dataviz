/**
 * useReviewTree — Review & Save's staged changes top-down, from the tree laid out in the browser
 * (`buildReviewTree`): each open container's level a window of its children, a page at a time, as
 * the server's tree is (`useChangeTree`) — so a container holding 20,000 changes draws 100 rows,
 * and revealing one deep in it opens the page it is on. A small review (a dozen changes or fewer)
 * opens every container as it appears: there is nothing to look for, just what changed.
 */
import { useCallback, useMemo, useState } from 'react'
import type { ChangeTreeItem } from '@/services/versioningApiService'
import type { ReviewGroup } from '../model/reviewModel'
import { buildReviewTree, pathOf, type Placement, type ReviewTree } from '../model/reviewTree'
import { flattenTree, TOP, TREE_PAGE, type TreeLevel } from './useChangeTree'

interface LevelWindow { start: number; pages: number }

/** At most this many changes: every container opens as it appears. */
const SMALL = 12

const noRetry = () => {}

export function useReviewTree(groups: readonly ReviewGroup[], place: () => Placement, enabled = true) {
  // Laid out once per list of changes, and only while shown.
  const tree: ReviewTree | null = useMemo(() => (enabled ? buildReviewTree(groups, place()) : null), [groups, enabled]) // eslint-disable-line react-hooks/exhaustive-deps
  const [windows, setWindows] = useState<ReadonlyMap<string, LevelWindow>>(() => new Map())
  const [open, setOpenSet] = useState<ReadonlySet<string>>(() => new Set())
  // A small review opens each container the first time it appears (closing one keeps it closed).
  const [seen, setSeen] = useState<{ tree: ReviewTree | null; ids: ReadonlySet<string> }>({ tree: null, ids: new Set() })
  if (tree && seen.tree !== tree) {
    const fresh = groups.length <= SMALL ? [...tree.children.keys()].filter((id) => id && !seen.ids.has(id)) : []
    setSeen({ tree, ids: new Set([...seen.ids, ...tree.children.keys()]) })
    if (fresh.length) setOpenSet((prev) => new Set([...prev, ...fresh]))
  }

  const itemOf = useCallback((id: string): ChangeTreeItem => {
    const r = tree!.rollup.get(id)
    return {
      id, name: tree!.nameOf(id), type: tree!.typeOf(id) ?? null, hasChildren: (tree!.children.get(id)?.length ?? 0) > 0,
      inside: { added: r?.[0] ?? 0, modified: r?.[1] ?? 0, removed: r?.[2] ?? 0 },
    }
  }, [tree])

  const levels = useMemo(() => {
    const out = new Map<string, TreeLevel>()
    if (!tree) return out
    for (const parent of [TOP, ...open]) {
      const all = tree.children.get(parent) ?? []
      const w = windows.get(parent) ?? { start: 0, pages: 1 }
      const start = Math.min(w.start, Math.max(0, all.length - 1))
      const items = all.slice(start, start + w.pages * TREE_PAGE).map(itemOf)
      out.set(parent, { items, start, total: all.length, loading: false, error: false, retry: noRetry })
    }
    return out
  }, [tree, open, windows, itemOf])
  const rows = useMemo(() => flattenTree(levels, open), [levels, open])

  const setOpen = useCallback((id: string, on: boolean) => setOpenSet((prev) => {
    if (prev.has(id) === on) return prev
    const next = new Set(prev)
    if (on) next.add(id)
    else next.delete(id)
    return next
  }), [])
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

  /** Open the way down to an item, each level at the page it is on. */
  const reveal = useCallback((id: string) => {
    if (!tree) return
    const chain = [TOP, ...pathOf(tree, id)]
    setWindows((prev) => {
      const next = new Map(prev)
      chain.forEach((parent, i) => {
        const at = tree.rank.get(chain[i + 1] ?? id) ?? 0
        const w = next.get(parent) ?? { start: 0, pages: 1 }
        if (at < w.start || at >= w.start + w.pages * TREE_PAGE) next.set(parent, { start: Math.floor(at / TREE_PAGE) * TREE_PAGE, pages: 1 })
      })
      return next
    })
    setOpenSet((prev) => new Set([...prev, ...chain.slice(1)]))
  }, [tree])

  return { tree, rows, levels, open, setOpen, more, earlier, collapseAll, reveal }
}
