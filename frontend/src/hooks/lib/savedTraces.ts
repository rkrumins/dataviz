/**
 * savedTraces — the traces a reader chose to keep, in this browser
 * (2026-11-18).
 *
 * History is a trail: it fills itself, it is capped, it forgets. A SAVED trace
 * is a decision — "this is the one I will need again" — so it is named, kept
 * until its owner removes it, and keeps what it found as well as how to ask
 * (the results live in their own record, see `traceSnapshot`, so listing the
 * saved traces never reads them).
 *
 * The recipe is exactly a history entry (`TraceHistoryEntryRecord`): seeds,
 * sides, hop limits, open cards — so opening a saved trace is the same
 * restore Back performs, against live data.
 *
 * Pure: no React, no storage. Hydration is defensive — what comes back from
 * storage was written by whichever version of this code ran last.
 */
import { traceEntrySeeds, traceSeedKey, type TraceHistoryEntryRecord } from './traceHistoryStack'

/** Saved traces kept per user and view; past it the oldest goes. */
export const SAVED_TRACES_CAP = 100
/** The longest name a saved trace keeps. */
export const SAVED_TRACE_NAME_MAX = 120

export interface SavedTrace {
  id: string
  name: string
  savedAt: number
  recipe: TraceHistoryEntryRecord
  /** The sender's names for the seeds, in `traceEntrySeeds(recipe)` order. */
  seedLabels: string[]
  counts: { nodes: number; upstream: number; downstream: number; edges: number }
  /** Its results were kept with it. False: the recipe alone (too large to
   *  keep, or the browser refused the space). */
  hasResults: boolean
  /** The walk had not finished when it was saved (it was paused at its memory
   *  checkpoint, or a step failed): the results are part of the trace. */
  partial: boolean
}

export const savedTraceKey = (t: Pick<SavedTrace, 'recipe'>) => traceSeedKey(traceEntrySeeds(t.recipe))

/** Keep `entry`, newest first. Saving a seed set already kept REPLACES it
 *  (one saved trace per question; saving again refreshes its results), and
 *  past the cap the oldest go — returned, so their results can be deleted. */
export function addSavedTrace(list: readonly SavedTrace[], entry: SavedTrace): { list: SavedTrace[]; dropped: SavedTrace[] } {
  const key = savedTraceKey(entry)
  const replaced = list.filter(t => savedTraceKey(t) === key)
  const rest = list.filter(t => savedTraceKey(t) !== key)
  const next = [entry, ...rest]
  return { list: next.slice(0, SAVED_TRACES_CAP), dropped: [...replaced.filter(t => t.id !== entry.id), ...next.slice(SAVED_TRACES_CAP)] }
}

export function renameSavedTrace(list: readonly SavedTrace[], id: string, name: string): SavedTrace[] {
  const clean = name.trim().slice(0, SAVED_TRACE_NAME_MAX)
  if (!clean) return [...list]
  return list.map(t => (t.id === id ? { ...t, name: clean } : t))
}

export function removeSavedTrace(list: readonly SavedTrace[], id: string): SavedTrace[] {
  return list.filter(t => t.id !== id)
}

/** The saved trace asking the same question (the same seed set), if any. */
export function findSavedTrace(list: readonly SavedTrace[], urns: readonly string[]): SavedTrace | undefined {
  const key = traceSeedKey(urns)
  return list.find(t => savedTraceKey(t) === key)
}

/** What a trace found now that it did not when it was saved, and the reverse. */
export function diffSinceSaved(saved: Iterable<string>, now: Iterable<string>): { added: string[]; removed: string[] } {
  const before = new Set(saved)
  const after = new Set(now)
  return {
    added: [...after].filter(u => !before.has(u)),
    removed: [...before].filter(u => !after.has(u)),
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function readRecipe(v: unknown): TraceHistoryEntryRecord | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  const view = r.view as Record<string, unknown> | undefined
  if (typeof r.urn !== 'string' || !r.urn || typeof r.focusId !== 'string' || !view) return null
  if (typeof view.showUpstream !== 'boolean' || typeof view.showDownstream !== 'boolean') return null
  if (!isNum(view.depthUp) || !isNum(view.depthDown) || !Array.isArray(view.traceExpansion)) return null
  const urns = Array.isArray(r.urns) && r.urns.every(u => typeof u === 'string' && u) ? r.urns as string[] : undefined
  return {
    urn: r.urn,
    ...(urns && urns.length > 1 ? { urns } : {}),
    focusId: r.focusId,
    view: {
      showUpstream: view.showUpstream,
      showDownstream: view.showDownstream,
      depthUp: view.depthUp,
      depthDown: view.depthDown,
      traceExpansion: view.traceExpansion.filter((e): e is string => typeof e === 'string'),
    },
    timestamp: isNum(r.timestamp) ? r.timestamp : 0,
  }
}

/** Saved traces back from storage: every well-formed one, the rest dropped. */
export function hydrateSavedTraces(raw: unknown): SavedTrace[] {
  if (typeof raw !== 'object' || raw === null || (raw as { v?: unknown }).v !== 1) return []
  const items = (raw as { items?: unknown }).items
  if (!Array.isArray(items)) return []
  const out: SavedTrace[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const t = item as Record<string, unknown>
    const recipe = readRecipe(t.recipe)
    const counts = t.counts as Record<string, unknown> | undefined
    if (!recipe || typeof t.id !== 'string' || typeof t.name !== 'string' || !isNum(t.savedAt) || !counts) continue
    out.push({
      id: t.id,
      name: t.name.slice(0, SAVED_TRACE_NAME_MAX),
      savedAt: t.savedAt,
      recipe,
      seedLabels: Array.isArray(t.seedLabels) ? t.seedLabels.filter((s): s is string => typeof s === 'string') : [],
      counts: {
        nodes: isNum(counts.nodes) ? counts.nodes : 0,
        upstream: isNum(counts.upstream) ? counts.upstream : 0,
        downstream: isNum(counts.downstream) ? counts.downstream : 0,
        edges: isNum(counts.edges) ? counts.edges : 0,
      },
      hasResults: t.hasResults === true,
      partial: t.partial === true,
    })
  }
  return out.slice(0, SAVED_TRACES_CAP)
}

export const serializeSavedTraces = (list: readonly SavedTrace[]) => ({ v: 1 as const, items: list })
