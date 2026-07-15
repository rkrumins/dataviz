/**
 * useActiveBranchGuard — never let a dead branch stay the active editing scope.
 *
 * A draft can stop being editable underneath you, from several directions: you published it, you
 * merged its PR (possibly from the Reviews inbox, with no canvas mounted), a teammate merged the
 * shared draft you were both on, someone discarded it from the Branch manager, or you followed a
 * stale `?branch=` link. In every one of those cases the server flips the branch to
 * `merged`/`abandoned`, but the client used to keep pointing `currentBranchId` at it — leaving you
 * "in a branch that doesn't exist", editing a scope whose writes the server rejects
 * (`_require_open`).
 *
 * Rather than bolt a `switchToMain()` onto each of those call sites — and miss the next one — this
 * derives liveness from server truth and self-heals: if the active branch is no longer `open`, eject
 * to Published. One rule, every path.
 *
 * Two deliberate constraints:
 *  • ACT ONLY ON AN EXPLICIT NON-OPEN STATUS. `list_branches` returns merged/abandoned branches (it
 *    filters by permission, not status), so a dead branch is *present* and says so. A branch that is
 *    merely ABSENT is ambiguous — a stale list, a view-scoped slice, a permission edge — and
 *    ejecting on absence would throw people out of drafts they had just opened.
 *  • WAIT FOR A SETTLED LIST. React-Query serves the stale list during a refetch, and a
 *    just-opened draft isn't in it yet. Same lesson `useBranchDeepLink` learned.
 */
import { useEffect, useRef } from 'react'
import { useBranchStore } from '@/store/branchStore'
import type { Branch } from '@/services/versioningApiService'

export type BranchEviction = { branchId: string; status: string; hadUnsavedEdits: boolean }

export function useActiveBranchGuard({
  enabled,
  branches,
  listRefreshing = false,
  currentBranchId,
  unsavedCount,
  onEvict,
}: {
  enabled: boolean
  branches: Branch[] | undefined
  /** True while the branches list is being (re)fetched — never evict on a stale list. */
  listRefreshing?: boolean
  currentBranchId: string | null
  /** Staged (unsaved, optimistic) edits on the canvas right now. */
  unsavedCount: number
  /** Told what happened, so the surface can explain it. Fires once per dead branch. */
  onEvict?: (e: BranchEviction) => void
}) {
  const evictedRef = useRef<string | null>(null)
  // Read unsavedCount through a ref: it must NOT be able to re-trigger the effect (a staged edit
  // landing at the wrong moment would re-run the eviction), it's only read at the instant we evict.
  // Synced in an effect, never during render — a render-phase ref write is not safe under concurrent
  // rendering, and React's lint rule rejects it.
  const unsavedRef = useRef(unsavedCount)
  useEffect(() => { unsavedRef.current = unsavedCount }, [unsavedCount])

  useEffect(() => {
    if (!enabled || !currentBranchId || !branches || listRefreshing) return
    if (evictedRef.current === currentBranchId) return

    const active = branches.find((b) => b.branchId === currentBranchId)
    if (!active || active.status === 'open') return   // absent ⇒ ambiguous; open ⇒ healthy

    // Latched per-branch: merged/abandoned are terminal, so a branch we evict from can never become
    // active again — the latch only stops a double-fire if the effect re-runs before the store's
    // switchToMain has propagated.
    evictedRef.current = currentBranchId
    useBranchStore.getState().switchToMain()
    onEvict?.({
      branchId: currentBranchId,
      status: active.status,
      hadUnsavedEdits: unsavedRef.current > 0,
    })
  }, [enabled, branches, listRefreshing, currentBranchId, onEvict])
}
