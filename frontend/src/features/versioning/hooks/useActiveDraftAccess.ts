/**
 * useActiveDraftAccess — what the caller may do with the draft they are on, as the server last
 * said: the freshness poll's `access` (live: a write lost to a change of level shows on its next
 * poll), else the version list's, else — not listed yet — its owner and role. Not known at all:
 * they may, and the server refuses a save they may not make.
 *
 * Shares the version list's and the freshness poll's queries with the switcher and the canvas bar,
 * so it asks the server nothing more.
 */
import { useAuthStore } from '@/store/auth'
import type { Branch } from '@/services/versioningApiService'
import { canManageDraft, canWriteDraft } from '../model/branchVocab'
import { useBranchFreshness, useBranches } from './useVersioning'

export function useActiveDraftAccess(
  wsId: string | undefined, graphId: string | null | undefined, viewId: string | null, branchId: string | null,
): { draft: Branch | null; canWrite: boolean; canManage: boolean } {
  const me = useAuthStore((s) => s.user?.id)
  const branchesQ = useBranches(wsId, viewId ? graphId : null, viewId)
  const freshness = useBranchFreshness(wsId, graphId, branchId)
  const draft = (branchId && branchesQ.data?.find((b) => b.branchId === branchId)) || null
  const live = freshness.data?.access
  return {
    draft,
    canWrite: live ? live.canWrite : draft ? canWriteDraft(draft, me) : true,
    canManage: live ? live.canManage : draft ? canManageDraft(draft, me) : true,
  }
}
