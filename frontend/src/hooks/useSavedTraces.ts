/**
 * useSavedTraces — a reader's saved traces in this view, kept in IndexedDB
 * (2026-11-18).
 *
 * Two kinds of record, so the list stays cheap to read however much was
 * saved: one INDEX per user and view (the names, recipes and counts), and one
 * SNAPSHOT per saved trace (its results, packed by `traceSnapshot`), read only
 * when someone exports or compares it.
 *
 * Space is the browser's to give. When it refuses a snapshot, the oldest
 * saved traces give up their results (their recipes stay) and the save is
 * tried once more; if it still does not fit, this one is kept as its recipe
 * and the reader is told. A browser with no IndexedDB (private mode, some
 * embedded views) keeps the list for this visit only, and says so.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { idbAvailable, idbDelete, idbGet, idbSet } from '@/lib/idbStore'
import {
  addSavedTrace,
  hydrateSavedTraces,
  removeSavedTrace,
  renameSavedTrace,
  serializeSavedTraces,
  type SavedTrace,
} from './lib/savedTraces'
import {
  packTraceSnapshot,
  TRACE_SNAPSHOT_MAX_ROWS,
  unpackTraceSnapshot,
  type TraceSnapshotRecord,
} from './lib/traceSnapshot'
import type { TraceExportEdge, TraceExportRow } from './lib/traceExport'

const NO_TRACES: SavedTrace[] = []
const indexKey = (userId: string, viewId: string) => `nx:saved-traces:v1:${userId}:${viewId}`
const snapKey = (id: string) => `nx:saved-trace-snap:v1:${id}`

export interface SaveTraceInput {
  name: string
  recipe: SavedTrace['recipe']
  seedLabels: string[]
  rows: readonly TraceExportRow[]
  edges: readonly TraceExportEdge[]
  counts: SavedTrace['counts']
  partial: boolean
}

export interface SaveTraceOutcome {
  saved: SavedTrace
  /** Said to the reader when the save is less than they asked for. */
  note: string | null
}

export interface SavedTraces {
  list: SavedTrace[]
  /** False: this browser keeps nothing; the list lasts for this visit. */
  persistent: boolean
  save: (input: SaveTraceInput) => Promise<SaveTraceOutcome>
  rename: (id: string, name: string) => void
  remove: (id: string) => void
  /** A saved trace's results, or null when it kept none (or they are gone). */
  results: (id: string) => Promise<{ rows: TraceExportRow[]; edges: TraceExportEdge[] } | null>
}

const newId = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)

export function useSavedTraces(userId: string, viewId: string): SavedTraces {
  const key = indexKey(userId, viewId)
  const persistent = idbAvailable()
  // Keyed by what it was read for, so a change of user or view shows nothing
  // stale while the new list loads — no reset inside an effect.
  const [stored, setStored] = useState<{ key: string; list: SavedTrace[] }>({ key, list: [] })
  const list = stored.key === key ? stored.list : NO_TRACES
  // The list as last written, for the async save path (a save must build on
  // what is stored, not on the render it started in).
  const listRef = useRef<SavedTrace[]>([])
  const keyRef = useRef(key)
  // In-memory snapshots for a browser with no IndexedDB.
  const memory = useRef(new Map<string, TraceSnapshotRecord>())

  useEffect(() => {
    keyRef.current = key
    let live = true
    listRef.current = []
    if (!persistent) return
    void idbGet<unknown>(key).then((raw) => {
      if (!live) return
      const hydrated = hydrateSavedTraces(raw)
      listRef.current = hydrated
      setStored({ key, list: hydrated })
    })
    return () => { live = false }
  }, [key, persistent])

  const commit = useCallback(async (next: SavedTrace[]) => {
    listRef.current = next
    setStored({ key: keyRef.current, list: next })
    if (persistent) await idbSet(keyRef.current, serializeSavedTraces(next))
  }, [persistent])

  const keepSnapshot = useCallback(async (id: string, snap: TraceSnapshotRecord): Promise<boolean> => {
    if (!persistent) { memory.current.set(id, snap); return true }
    return idbSet(snapKey(id), snap)
  }, [persistent])

  const dropSnapshot = useCallback((id: string) => {
    memory.current.delete(id)
    if (persistent) void idbDelete(snapKey(id))
  }, [persistent])

  const save = useCallback(async (input: SaveTraceInput): Promise<SaveTraceOutcome> => {
    const id = newId()
    let note: string | null = persistent ? null : 'Kept for this visit only — this browser keeps no saved data.'
    let hasResults = false
    if (input.rows.length > TRACE_SNAPSHOT_MAX_ROWS) {
      note = `Saved without its results — ${input.rows.length.toLocaleString()} rows is more than this browser keeps. Opening it runs it again.`
    } else {
      const snap = await packTraceSnapshot(input.rows, input.edges)
      hasResults = await keepSnapshot(id, snap)
      if (!hasResults) {
        // Out of space: the oldest saved traces give up their results.
        const withResults = listRef.current.filter(t => t.hasResults)
        const evict = withResults.slice(Math.max(0, withResults.length - Math.ceil(withResults.length / 2)))
        for (const t of evict) dropSnapshot(t.id)
        const evicted = new Set(evict.map(t => t.id))
        listRef.current = listRef.current.map(t => (evicted.has(t.id) ? { ...t, hasResults: false } : t))
        hasResults = await keepSnapshot(id, snap)
        note = hasResults
          ? `Saved. To make room, ${evict.length} older saved trace${evict.length === 1 ? '' : 's'} kept only how to run them again.`
          : 'Saved without its results — this browser is out of space for them. Opening it runs it again.'
      }
    }
    const saved: SavedTrace = {
      id,
      name: input.name,
      savedAt: Date.now(),
      recipe: input.recipe,
      seedLabels: input.seedLabels,
      counts: input.counts,
      hasResults,
      partial: input.partial,
    }
    const { list: next, dropped } = addSavedTrace(listRef.current, saved)
    for (const t of dropped) dropSnapshot(t.id)
    await commit(next)
    return { saved, note }
  }, [persistent, keepSnapshot, dropSnapshot, commit])

  const rename = useCallback((id: string, name: string) => {
    void commit(renameSavedTrace(listRef.current, id, name))
  }, [commit])

  const remove = useCallback((id: string) => {
    dropSnapshot(id)
    void commit(removeSavedTrace(listRef.current, id))
  }, [commit, dropSnapshot])

  const results = useCallback(async (id: string) => {
    const record = persistent ? await idbGet<unknown>(snapKey(id)) : memory.current.get(id)
    return unpackTraceSnapshot(record ?? null)
  }, [persistent])

  return { list, persistent, save, rename, remove, results }
}
