/**
 * useBranchDeepLink — two-way sync between the URL `?branch=<id>` query param and the active branch
 * in the branch store, so a view+branch is a shareable, bookmarkable link
 * (e.g. /views/view_abc?branch=br_123).
 *
 *   • URL → store: on load, if `?branch=<id>` names an OPEN draft the viewer may access (it appears
 *     in the permission-gated branches list), switch to it. If it's missing / not accessible, drop
 *     the param, stay on main, and toast — so a shared link only works for permitted users.
 *   • store → URL: reflect the active branch as `?branch=<id>` (replace, no history spam); main
 *     clears the param. So switching branches updates the link, and "Copy link" is always current.
 */
import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useToast } from '@/components/ui/toast'
import type { Branch } from '@/services/versioningApiService'

export function useBranchDeepLink({
  enabled,
  branches,
  listRefreshing = false,
  currentBranchId,
  switchToDraft,
}: {
  enabled: boolean
  branches: Branch[] | undefined
  /** True while the branches list is being (re)fetched — a REJECT decision must
   *  wait for the settled list (react-query serves the stale one meanwhile, and
   *  a just-opened draft may not be in it yet); an ACCEPT can act immediately. */
  listRefreshing?: boolean
  currentBranchId: string | null
  switchToDraft: (branchId: string, originatingViewId?: string | null) => void
}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const { showToast } = useToast()
  const urlBranch = searchParams.get('branch')
  const handledRef = useRef<string | null>(null) // a branch param we've already resolved (apply/reject)
  const wasActiveRef = useRef(false) // have we ever held a non-null branch? distinguishes "left a branch" from a fresh deep-link still mid-apply

  // URL → store: apply the deep-linked branch once the (permission-gated) branch list is loaded.
  useEffect(() => {
    if (!enabled || !branches || !urlBranch) return
    if (urlBranch === currentBranchId) { handledRef.current = urlBranch; return }
    if (handledRef.current === urlBranch) return
    const target = branches.find((b) => b.branchId === urlBranch && b.kind !== 'main' && b.status === 'open')
    if (target) {
      handledRef.current = urlBranch
      switchToDraft(target.branchId, target.originatingViewId ?? null)
    } else if (!listRefreshing) {
      // Not accessible / not found on a SETTLED list → drop the param and stay on main.
      handledRef.current = urlBranch
      setSearchParams((prev) => { const n = new URLSearchParams(prev); n.delete('branch'); return n }, { replace: true })
      showToast('error', "That branch isn't available — you may not have access, or it was merged/discarded.")
    }
    // else: mid-refresh — leave unhandled so the effect re-decides on fresh data.
  }, [enabled, branches, listRefreshing, urlBranch, currentBranchId, switchToDraft, setSearchParams, showToast])

  // store → URL: keep the param in step with the active branch (idempotent; guarded against loops).
  useEffect(() => {
    if (!enabled) return
    if (currentBranchId) wasActiveRef.current = true
    const cur = searchParams.get('branch')
    if (currentBranchId) {
      if (cur !== currentBranchId) {
        setSearchParams((prev) => { const n = new URLSearchParams(prev); n.set('branch', currentBranchId); return n }, { replace: true })
      }
    } else if (cur && wasActiveRef.current) {
      // Only clear once we've genuinely LEFT a branch. Never strip a deep-link param that URL→store
      // hasn't applied yet — on a fresh load `currentBranchId` is null while branches load, and this
      // effect runs first; without the guard it would erase `?branch=` before the link is honoured.
      setSearchParams((prev) => { const n = new URLSearchParams(prev); n.delete('branch'); return n }, { replace: true })
    }
  }, [enabled, currentBranchId, searchParams, setSearchParams])
}
