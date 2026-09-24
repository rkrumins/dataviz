/**
 * useSubsetCanvas — the Subset Studio, as the source canvas sees it.
 *
 * While the studio is open on this view, a click on a row PICKS it (or takes
 * it back out) instead of selecting it; the rows the picks cover stay lit and
 * the rest dim; and the picks become the member set the canvas previews
 * virtual hops over. Nothing here writes the canvas store: the view behind
 * the studio is exactly as it was when the studio closes.
 */
import { useCallback, useMemo } from 'react'

import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useNotificationStore } from '@/components/ui/notifications'
import type { LineageBridgeMember } from '@/providers/GraphDataProvider'
import type { HierarchyNode } from '@/types/hierarchy'
import type { LayerAssignmentEntry } from '@/types/schema'

import { coveredRows, coveringAncestor } from '../model/coverage'
import { SUBSET_MEMBERS_MAX } from '../model/limits'
import { orderedPicks, useSubsetStudioStore, type SubsetPick } from '../model/studioStore'

/** How long the picks must sit still before the preview re-asks the graph. */
export const PREVIEW_SETTLE_MS = 600

const LOGICAL_PREFIX = 'logical:'

export interface SubsetCanvasInputs {
  viewId: string | undefined
  displayMap: ReadonlyMap<string, HierarchyNode>
  nodeLayerMap: ReadonlyMap<string, string>
  nodeGroupMap: ReadonlyMap<string, { id: string; name: string }>
  childMap: ReadonlyMap<string, readonly string[]>
  parentMap: ReadonlyMap<string, string>
  urnToIdMap: ReadonlyMap<string, string>
  /** The source view's own members, as its layout places them. */
  assignments: Readonly<Record<string, LayerAssignmentEntry>>
}

export interface SubsetCanvas {
  /** The studio is open on this view. */
  active: boolean
  /** Rows the subset holds — lit while the rest dims. Empty when inactive. */
  coveredRowIds: ReadonlySet<string>
  /** Pick a row, or take it back out (a group row: all it holds). */
  pickRow: (rowId: string) => void
  /** Pick every row of a range (a shift-click), as one undoable batch. */
  pickRows: (rowIds: readonly string[]) => void
  /** The picks as a virtual-hop member set, settled after edits stop. */
  previewMembers: readonly LineageBridgeMember[]
  /** The picks by row, for marking them on the canvas. */
  picksByRow: ReadonlyMap<string, SubsetPick>
}

const EMPTY_ROWS: ReadonlySet<string> = new Set()
const EMPTY_MEMBERS: readonly LineageBridgeMember[] = []

export function useSubsetCanvas({
  viewId,
  displayMap,
  nodeLayerMap,
  nodeGroupMap,
  childMap,
  parentMap,
  urnToIdMap,
  assignments,
}: SubsetCanvasInputs): SubsetCanvas {
  const sourceViewId = useSubsetStudioStore((s) => s.sourceViewId)
  const picks = useSubsetStudioStore((s) => s.picks)
  const order = useSubsetStudioStore((s) => s.order)
  const active = !!viewId && sourceViewId === viewId

  const rowOf = useCallback((urn: string) => urnToIdMap.get(urn) ?? urn, [urnToIdMap])
  const list = useMemo(() => orderedPicks({ picks, order }), [picks, order])
  const picksByRow = useMemo(() => new Map(list.map(p => [rowOf(p.urn), p])), [list, rowOf])

  const coveredRowIds = useMemo(
    () => (active ? coveredRows(list, childMap, rowOf) : EMPTY_ROWS),
    [active, list, childMap, rowOf],
  )

  /** A row as a pick: where it sits in the source view and what it is. */
  const pickFor = useCallback((row: HierarchyNode): SubsetPick | null => {
    const layerId = nodeLayerMap.get(row.id)
    if (!layerId) return null
    const urn = row.urn || row.id
    const own = assignments[urn]
    const group = nodeGroupMap.get(row.id)?.id
    return {
      urn,
      layerId,
      logicalNodeId: own ? own.logicalNodeId : group?.startsWith(LOGICAL_PREFIX) ? group.slice(LOGICAL_PREFIX.length) : undefined,
      inheritsChildren: own ? own.inheritsChildren !== false : true,
      origin: 'picked',
      label: row.name || urn,
      entityType: typeof row.data?.type === 'string' ? row.data.type : undefined,
    }
  }, [nodeLayerMap, nodeGroupMap, assignments])

  const pickRow = useCallback((rowId: string) => {
    const store = useSubsetStudioStore.getState()
    const notify = useNotificationStore.getState().add
    const row = displayMap.get(rowId)
    if (!row) return

    // A group row stands for what it holds: pick them all, or — when every
    // one is already in — take them all out.
    if (row.isLogical) {
      const inside = row.children.filter(c => !c.isLogical).map(pickFor).filter((p): p is SubsetPick => !!p)
      if (inside.length === 0) return
      const allIn = inside.every(p => store.picks[p.urn])
      if (allIn) {
        store.remove(inside.map(p => p.urn), `Remove ${row.name}`)
      } else {
        const added = store.add(inside, `Add ${row.name}`)
        if (added < inside.filter(p => !store.picks[p.urn]).length) {
          notify({ type: 'warning', message: `A subset holds at most ${SUBSET_MEMBERS_MAX.toLocaleString()} entities — some of ${row.name} were left out.` })
        }
      }
      return
    }

    const pick = pickFor(row)
    if (!pick) return
    if (!store.picks[pick.urn]) {
      const cover = coveringAncestor(rowId, picksByRow, parentMap)
      if (cover) {
        notify({ type: 'info', message: `${pick.label} is already in the subset — it comes with ${cover.label}.` })
        return
      }
    }
    if (store.toggle(pick) === 'full') {
      notify({ type: 'warning', message: `A subset holds at most ${SUBSET_MEMBERS_MAX.toLocaleString()} entities.` })
    }
  }, [displayMap, pickFor, picksByRow, parentMap])

  const pickRows = useCallback((rowIds: readonly string[]) => {
    const store = useSubsetStudioStore.getState()
    const rows = rowIds.map(id => displayMap.get(id)).filter((r): r is HierarchyNode => !!r && !r.isLogical)
    const fresh = rows
      .filter(r => !coveringAncestor(r.id, picksByRow, parentMap))
      .map(pickFor)
      .filter((p): p is SubsetPick => !!p && !store.picks[p.urn])
    if (fresh.length === 0) return
    if (store.add(fresh, `Add ${fresh.length.toLocaleString()} entities`) < fresh.length) {
      useNotificationStore.getState().add({ type: 'warning', message: `A subset holds at most ${SUBSET_MEMBERS_MAX.toLocaleString()} entities — some were left out.` })
    }
  }, [displayMap, pickFor, picksByRow, parentMap])

  const members = useMemo<readonly LineageBridgeMember[]>(
    () => (active ? list.map(p => ({ urn: p.urn, inheritsChildren: p.inheritsChildren })) : EMPTY_MEMBERS),
    [active, list],
  )
  const previewMembers = useDebouncedValue(members, PREVIEW_SETTLE_MS)

  return { active, coveredRowIds, pickRow, pickRows, previewMembers: active ? previewMembers : EMPTY_MEMBERS, picksByRow }
}
