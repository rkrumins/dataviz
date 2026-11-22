/**
 * stageEdgeEdit — the ONE way a relationship's properties are staged, whatever edited them (the
 * relationship drawer, or several relationships compared and edited as one).
 *
 * A relationship has at most one staged edit (`edit_edge`). It keeps the properties as they were
 * FIRST read, with their token (`before` — the diff base the save sends a patch against, and its
 * concurrency check), and the latest (`after`). An edit that nets out to nothing — everything put
 * back — drops the staged change instead of saving a no-op.
 *
 * A batch is one write to the staged changes and one Undo step (`replaceMany`), so a thousand
 * relationships stage as fast as one. Canvas lines carry no properties: nothing on the canvas moves.
 */
import { generateId } from '@/lib/utils'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { propertiesPatch } from './stagedChangesToOps'

type Props = Record<string, unknown>

export interface EdgeEdit {
  /** The versioned entity id — what the save addresses. */
  edgeId: string
  /** Its properties as the caller read them just now, and their token. */
  current: { properties: Props; version?: string }
  /** Its properties as they should end up. */
  after: Props
  /** How it reads in Review. */
  summary: string
}

const propsOf = (v: unknown): Props => ((v as { properties?: Props } | undefined)?.properties) ?? {}

/**
 * Stage many relationship edits as one action, each exactly as staging it alone would: merged into
 * the relationship's staged edit (keeping that edit's `before`), or dropping it when the edit nets
 * out to nothing. A relationship named twice takes its last edit. Returns the Undo step's id (none
 * when nothing changed).
 */
export function stageEdgeEdits(edits: readonly EdgeEdit[]): string | undefined {
  const store = useStagedChangesStore.getState()
  const existingFor = new Map<string, StagedChange>()
  for (const c of store.changes) if (c.type === 'edit_edge' && !existingFor.has(c.targetId)) existingFor.set(c.targetId, c)
  const entries: { before: StagedChange | null; after: StagedChange | null }[] = []

  for (const { edgeId, current, after, summary } of new Map(edits.map((e) => [e.edgeId, e])).values()) {
    const existing = existingFor.get(edgeId) ?? null
    const before = existing?.before
      ?? { properties: current.properties, ...(current.version ? { version: current.version } : {}) }
    const patch = propertiesPatch(propsOf(before), after)
    if (Object.keys(patch.set).length === 0 && patch.unset.length === 0) {
      // Back where it started: nothing to save — but the step that put it back can be undone.
      if (existing) entries.push({ before: existing, after: null })
      continue
    }
    entries.push({
      before: existing,
      after: existing
        ? { ...existing, after: { properties: after }, summary, timestamp: Date.now() }
        : { id: generateId('staged'), type: 'edit_edge', targetId: edgeId, before, after: { properties: after }, summary, timestamp: Date.now() },
    })
  }
  return entries.length ? store.replaceMany(entries) : undefined
}
