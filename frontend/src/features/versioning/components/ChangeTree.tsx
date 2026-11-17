/**
 * ChangeTree — a change list top-down: what changed under its containers, from the top, a level at
 * a time — the database first, then its schemas, then its tables — each container saying how many
 * changes sit under it, so a reviewer goes where the change is, one step at a time, instead of
 * scrolling 100,000 rows.
 *
 * The server lays the tree out once per version of the list, without payloads, and hands it out a
 * level and a page at a time (`useChangeTree`); `TreeView` draws the rows open. A change in it is
 * the same row as in the list (`renderChange`): its summary, then its key differences, then all of
 * them. `reveal` opens the way down to a change (a search result's "In hierarchy").
 */
import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { ChangeListRow, ChangeTreeItem } from '@/services/versioningApiService'
import { stopOf, useChangeNavigatorStore } from '@/store/changeNavigatorStore'
import type { RowLevel } from '@/hooks/useExpandableRows'
import { useChangeTree, type ChangeTreeSource } from '../hooks/useChangeTree'
import { TreeView, type TreeRowFrame } from './TreeView'

export type { TreeRowFrame }

export interface ChangeTreeProps {
  source: ChangeTreeSource
  /** How a change draws itself — the list's own row. */
  renderChange: (row: ChangeListRow, frame: TreeRowFrame) => ReactNode
  /** The list's own keys on a change (accept, reject, comment, show). */
  changeKeys?: (e: KeyboardEvent, row: ChangeListRow, setLevel: (level: RowLevel) => void, show: () => void) => boolean
  /** Open the way down to this change, then land on it (a new `nonce` each time it is asked). */
  reveal?: { entityId: string; nonce: number } | null
  maxHeight?: number | string
}

const isChange = (i: ChangeTreeItem) => !!i.change
const nameOf = (i: ChangeTreeItem) => (i.change
  ? (i.change.kind === 'node' ? i.change.displayName || i.change.urn || i.change.entityId
    : `${i.change.sourceName || '…'} → ${i.change.targetName || '…'}`)
  : i.name || i.id)

export function ChangeTree({ source, renderChange, changeKeys, reveal, maxHeight = '60vh' }: ChangeTreeProps) {
  const tree = useChangeTree(source)

  // The changes at a level, as canvas stops: what "Show" steps through.
  const saved = 'branchId' in source.origin
  const showFrom = useCallback((item: ChangeTreeItem, level: readonly ChangeTreeItem[]) => {
    const stops = level.flatMap((i) => (i.change && i.change.kind === 'node' && i.change.status !== 'removed' ? [stopOf(i.change, saved)] : []))
    const id = item.change ? (item.change.urn ?? item.change.entityId) : item.id
    useChangeNavigatorStore.getState().start(stops, { scope: 'saved', atId: id })
  }, [saved])

  // Revealing a change: read where it sits, open the way down, then land on it once it is drawn.
  const [land, setLand] = useState<string | null>(null)
  // The reveal (by its nonce) that could not find its way: said until the next one is asked.
  const [failed, setFailed] = useState<number | null>(null)
  const revealFailed = !!reveal && failed === reveal.nonce
  const { pathOf, reveal: openPath } = tree
  useEffect(() => {
    if (!reveal) return
    let live = true
    pathOf(reveal.entityId)
      .then((p) => { if (live) { openPath(p); setLand(reveal.entityId) } })
      .catch(() => { if (live) setFailed(reveal.nonce) })
    return () => { live = false }
  }, [reveal, pathOf, openPath])

  return (
    <TreeView model={tree} label="Changes, top-down" isChange={isChange} nameOf={nameOf}
      renderChange={(item, frame) => renderChange(item.change!, frame)}
      itemKeys={changeKeys ? (e, item, setLevel, show) => changeKeys(e, item.change!, setLevel, show) : undefined}
      showFrom={showFrom} land={land} onLanded={() => setLand(null)} maxHeight={maxHeight}
      notice={revealFailed ? <p role="alert" className="text-[11px] text-ink-muted">Couldn't find where that change sits. Try again in a moment.</p> : null} />
  )
}
