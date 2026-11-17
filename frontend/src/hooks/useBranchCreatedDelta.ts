/**
 * useBranchCreatedDelta — the set of URNs created (`create_entity`) in the active
 * branch's draft, read from `stagedChangesStore`.
 *
 * Why it exists: a CLOSED-SCOPE Context Model view (one with persisted
 * `entityAssignments`) deliberately ignores a node's GLOBAL `layerAssignment`
 * property, because honouring it for arbitrary nodes would leak in entities the
 * view never assigned (cross-view contamination). But an entity you JUST created
 * in this branch's draft has no persisted `entityAssignment` yet, so it would
 * never render. This delta is the leak-safe key: `useLayerAssignment` honours the
 * node `layerAssignment` in closed-scope ONLY for URNs in this set — the entities
 * this branch actually created, and nothing else.
 *
 * The store's active-scope slice lives in `changes` (its `_scopeKey`/`setScope`
 * machinery keeps `changes` pointed at exactly the current branch's edits), so the
 * delta is inherently scoped to the active branch. Each `create_entity` staged
 * change stamps its new entity's urn on `targetUrn` (see stageBuildRows /
 * useStageEntityCreation).
 */
import { useMemo } from 'react'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { useBranchStore } from '@/store/branchStore'
import type { ChangeSet } from '@/features/versioning/model/changeModel'

/**
 * PURE: the target URNs of every live-STAGED (not-yet-saved) `create_entity`
 * change. Optimistic coverage before the draft is committed.
 */
export function branchCreatedUrns(changes: StagedChange[]): Set<string> {
  const urns = new Set<string>()
  for (const c of changes) {
    if (c.type === 'create_entity' && c.targetUrn) urns.add(c.targetUrn)
  }
  return urns
}

/**
 * PURE: URNs created (`added` NODE changes) and COMMITTED in the active branch,
 * read from the branch changeset. Unlike the staged store — which clears on save —
 * this survives reload, so a saved-then-reloaded created entity stays in the delta
 * (the actual user bug: entities committed to the draft but invisible after save).
 */
export function committedCreatedUrns(changeSet: ChangeSet | null): Set<string> {
  const urns = new Set<string>()
  // A branch's own: two revisions compared on the canvas are highlighted, never "created here".
  if (!changeSet || changeSet.origin !== 'branch') return urns
  for (const c of changeSet.changes) {
    const urn = c.urn ?? c.entityId   // the name the canvas loads a node by; an imported entity's id is not it
    if (c.status === 'added' && c.kind === 'node' && urn) urns.add(urn)
  }
  return urns
}

/**
 * PURE: nodes the branch created AS A CHILD — the target of a containment link the branch added.
 * They are reached through their parent (the draft read serves them in its children), so loading
 * them flat alongside the view's roots made one whose parent was not loaded render as a root: an
 * orphan. `containmentTypes` is the ontology's containment relationship types.
 */
export function committedCreatedChildUrns(
  changeSet: ChangeSet | null, containmentTypes: readonly string[],
): Set<string> {
  const urns = new Set<string>()
  if (!changeSet || changeSet.origin !== 'branch' || containmentTypes.length === 0) return urns
  const cset = new Set(containmentTypes.map((t) => t.toUpperCase()))
  for (const c of changeSet.changes) {
    if (c.status !== 'added' || c.kind !== 'edge') continue
    const after = (c.after ?? {}) as Record<string, unknown>
    const type = String(after.edgeType ?? after.edge_type ?? '').toUpperCase()
    const target = c.targetUrn ?? after.targetEntityId ?? after.target_entity_id
    if (cset.has(type) && typeof target === 'string') urns.add(target)
  }
  return urns
}

/** A key that changes exactly when a set of URNs does — its size and two order-independent sums of
 *  each URN's hash — without sorting the set or joining it into one string (at 100,000 URNs, a
 *  multi-megabyte string built again for every new change set). */
export function urnSetKey(urns: Iterable<string>): string {
  let n = 0, sum = 0, xor = 0
  for (const u of urns) {
    let h = 0x811c9dc5                       // FNV-1a, 32-bit
    for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u.charCodeAt(i), 0x01000193) >>> 0
    sum = (sum + h) >>> 0
    xor = (xor ^ Math.imul(h, 0x9e3779b1)) >>> 0
    n++
  }
  return n === 0 ? '' : `${n}:${sum.toString(36)}:${xor.toString(36)}`
}

/** A set of urns and a content key for it, built once per source and shared by every reader. */
export interface KeyedUrns { set: Set<string>; key: string }

const EMPTY: KeyedUrns = { set: new Set(), key: '' }
const stagedCreates = new WeakMap<readonly StagedChange[], KeyedUrns>()
const committedCreates = new WeakMap<ChangeSet, KeyedUrns>()

/** `branchCreatedUrns`, built once per staged list. */
export function stagedCreatesOf(changes: readonly StagedChange[]): KeyedUrns {
  let out = stagedCreates.get(changes)
  if (!out) {
    const set = branchCreatedUrns(changes as StagedChange[])
    out = set.size ? { set, key: urnSetKey(set) } : EMPTY
    stagedCreates.set(changes, out)
  }
  return out
}

/** `committedCreatedUrns` and its key, built once per change set — a 100k-change draft's are read
 *  by hydration and by every layer grouping, and must not be rebuilt for each of them. */
export function committedCreatesOf(changeSet: ChangeSet | null): KeyedUrns {
  if (!changeSet) return EMPTY
  let out = committedCreates.get(changeSet)
  if (!out) {
    const set = committedCreatedUrns(changeSet)
    out = set.size ? { set, key: urnSetKey(set) } : EMPTY
    committedCreates.set(changeSet, out)
  }
  return out
}

/**
 * Reactive branch-created delta for the active scope: live-staged creates (optimistic)
 * UNION committed-in-branch creates (durable across reload). Both are genuinely
 * "created in THIS branch", so honouring the node `layerAssignment` for them in
 * closed-scope stays leak-safe.
 *
 * Content-stable: it is a new Set only when what was created changes. Every other staged edit
 * (a rename, a property) leaves it — and the layer grouping keyed on it — as it was.
 */
export function useBranchCreatedDelta(): Set<string> {
  const stagedKey = useStagedChangesStore((s) => stagedCreatesOf(s.changes).key)
  const committedKey = useBranchStore((s) => committedCreatesOf(s.activeChangeSet).key)
  return useMemo(() => {
    const staged = stagedCreatesOf(useStagedChangesStore.getState().changes).set
    const committed = committedCreatesOf(useBranchStore.getState().activeChangeSet).set
    if (staged.size === 0) return committed
    if (committed.size === 0) return staged
    return new Set([...committed, ...staged])
  // Keyed on content, not on the arrays it is read from: that is the point of this hook.
  }, [stagedKey, committedKey]) // eslint-disable-line react-hooks/exhaustive-deps
}
