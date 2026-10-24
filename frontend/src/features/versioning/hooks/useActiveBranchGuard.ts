/**
 * useActiveBranchGuard — never let a dead branch stay the active editing scope.
 *
 * A draft can stop being editable underneath you, from several directions: you published it, you
 * merged its PR (possibly from the Reviews inbox, with no canvas mounted), a teammate merged the
 * shared draft you were both on, someone discarded it from the Branch manager, or you followed a
 * stale `?branch=` link. In every one of those cases the server flips the branch to
 * `merged`/`abandoned`, but the client used to keep pointing `currentBranchId` at it — leaving you
 * "in a branch that doesn't exist", editing a scope whose writes the server rejects
 * (`_require_open`, 409 branch_closed).
 *
 * Rather than bolt a `switchToMain()` onto each of those call sites — and miss the next one — this
 * derives liveness from server truth and self-heals: if the active branch is merged or abandoned,
 * eject to Published. One rule, every path. A `publishing` draft stays active: a failed publish hands
 * it back as `open`, and saves made meanwhile get branch_closed, which the save path handles.
 *
 * ACT ONLY ON AN EXPLICIT NON-OPEN STATUS. The status is the active branch's own, read from that one
 * branch (its freshness) — not from a list of every draft ever made, which grows without bound. A
 * status not known yet (unread, a read that failed) is ambiguous, and ejecting on it would throw
 * people out of drafts they had just opened.
 */
import { useEffect, useRef } from 'react'
import { useBranchStore } from '@/store/branchStore'

export type BranchEviction = { branchId: string; status: string; hadUnsavedEdits: boolean }

export function useActiveBranchGuard({
  enabled,
  status,
  currentBranchId,
  unsavedCount,
  onEvict,
}: {
  enabled: boolean
  /** The active branch's status, read from that branch; undefined while unknown. */
  status: string | undefined
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
    if (!enabled || !currentBranchId) return
    if (evictedRef.current === currentBranchId) return

    // unknown ⇒ ambiguous; open ⇒ healthy; publishing ⇒ may come back open
    if (!status || status === 'open' || status === 'publishing') return

    // Latched per-branch: merged/abandoned are terminal, so a branch we evict from can never become
    // active again — the latch only stops a double-fire if the effect re-runs before the store's
    // switchToMain has propagated.
    evictedRef.current = currentBranchId
    useBranchStore.getState().switchToMain()
    onEvict?.({
      branchId: currentBranchId,
      status,
      hadUnsavedEdits: unsavedRef.current > 0,
    })
  }, [enabled, status, currentBranchId, onEvict])
}
