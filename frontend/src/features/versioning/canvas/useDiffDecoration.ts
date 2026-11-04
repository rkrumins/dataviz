/**
 * useEntityChangeDecoration — the single source of truth for "how has this entity changed?",
 * shared by every canvas surface (graph nodes, the context tree) so they speak ONE visual
 * language. It merges two layers:
 *
 *   • STAGED (uncommitted) edits from the staged-changes store — your live, unsaved work.
 *     Always shown (it's immediate editing feedback) and takes precedence.
 *   • COMMITTED branch changes vs main from the active ChangeSet — saved to this draft but not
 *     merged. Shown by default; hidden when the user toggles `committedDiffHidden` (so older
 *     committed work doesn't clutter the view).
 *
 * Visual language (see the class maps below): line STYLE encodes commit state — dashed = staged
 * (unsaved), solid = committed (not merged); COLOR encodes the change — emerald=added,
 * amber=modified, rose=removed. This is what makes "saved vs not" unmistakable at a glance.
 */
import { useMemo } from 'react'
import { useBranchStore } from '@/store/branchStore'
import { useStagedChangesStore, type StagedChange, type StagedChangeType } from '@/store/stagedChangesStore'
import type { ChangeStatus } from '../model/changeModel'

export type ChangeState = 'staged' | 'committed'
export interface EntityDecoration {
  state: ChangeState
  status: ChangeStatus
}

const stagedStatus = (t: StagedChangeType): ChangeStatus =>
  t.startsWith('create') ? 'added' : t.startsWith('delete') ? 'removed' : 'modified'

const COMMITTED: Record<ChangeStatus, EntityDecoration> = {
  added: { state: 'committed', status: 'added' },
  modified: { state: 'committed', status: 'modified' },
  removed: { state: 'committed', status: 'removed' },
}

// Every node and row on the canvas runs this hook, so nothing in it may cost the size of the change
// set: each one used to build its own map of every committed change — at 100,000 changes and a few
// hundred rows mounted, tens of millions of inserts and gigabytes held. Committed changes are read
// from the change set's own index (`byEntityId`, built once), and the staged edits' map is built
// once per version of the staged list and shared by everything that asks.
const stagedLookups = new WeakMap<readonly StagedChange[], Map<string, EntityDecoration>>()

function stagedLookup(staged: readonly StagedChange[]): Map<string, EntityDecoration> {
  let m = stagedLookups.get(staged)
  if (!m) {
    m = new Map()
    // Keyed by both id and urn so canvas urns and temp ids both resolve; the last edit wins.
    for (const sc of staged) {
      const d: EntityDecoration = { state: 'staged', status: stagedStatus(sc.type) }
      if (sc.targetUrn) m.set(sc.targetUrn, d)
      if (sc.targetId) m.set(sc.targetId, d)
    }
    stagedLookups.set(staged, m)
  }
  return m
}

export function useEntityChangeDecoration() {
  const committedHidden = useBranchStore((s) => s.committedDiffHidden)
  const changeSet = useBranchStore((s) => s.activeChangeSet)
  const stagedChanges = useStagedChangesStore((s) => s.changes)
  const staged = useMemo(() => stagedLookup(stagedChanges), [stagedChanges])

  return {
    /** Whether any committed change exists for this branch (drives the show/hide toggle's relevance). */
    hasCommitted: !!changeSet && changeSet.changes.length > 0,
    committedHidden,
    /** The decoration for a node urn / edge id, or undefined when unchanged / hidden. Staged
     *  (unsaved) edits take precedence over committed ones, which show unless hidden. */
    for: (entityId?: string | null): EntityDecoration | undefined => {
      if (!entityId) return undefined
      const s = staged.get(entityId)
      if (s) return s
      if (committedHidden || !changeSet) return undefined
      const c = changeSet.byEntityId.get(entityId)
      return c ? COMMITTED[c.status] : undefined
    },
  }
}

// ── Tailwind-literal class maps (JIT can't see interpolated class names) ─────────────────────────
// The COLOR ring/glow (added=emerald, modified=amber, removed=rose) is the existing, well-loved
// highlight — kept verbatim for both states. STAGED builds ON TOP of it by adding a dashed halo
// (outline) so "unsaved" reads at a glance without losing the colour language; COMMITTED is the
// solid ring alone.
// Green = create, Orange = update, Rose = delete — the colour language users already know.
const COMMITTED_RING: Record<ChangeStatus, string> = {
  added: 'ring-2 ring-emerald-500/70 shadow-[0_0_18px_-2px_rgba(16,185,129,0.45)]',
  modified: 'ring-2 ring-orange-500/70 shadow-[0_0_18px_-2px_rgba(249,115,22,0.45)]',
  removed: 'ring-2 ring-rose-500/70 opacity-70 shadow-[0_0_18px_-2px_rgba(244,63,94,0.45)]',
}
const STAGED_HALO: Record<ChangeStatus, string> = {
  added: 'outline-dashed outline-2 outline-offset-2 outline-emerald-300/80',
  modified: 'outline-dashed outline-2 outline-offset-2 outline-orange-300/80',
  removed: 'outline-dashed outline-2 outline-offset-2 outline-rose-300/80',
}
export const nodeDecorationClass = (d?: EntityDecoration): string => {
  if (!d) return ''
  // committed colour ring for both; staged adds the dashed halo on top.
  return d.state === 'staged' ? `${COMMITTED_RING[d.status]} ${STAGED_HALO[d.status]}` : COMMITTED_RING[d.status]
}
