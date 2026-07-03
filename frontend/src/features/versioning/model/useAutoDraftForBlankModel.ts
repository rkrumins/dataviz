/**
 * useAutoDraftForBlankModel — a brand-new blank model should open ready to build,
 * not read-only: when the resolved graph is a genesis-only `kind === 'blank'` model
 * and the caller can manage it, open (or resume) their draft automatically so the
 * first thing they see is an editable canvas with the guided empty state.
 *
 * One-shot per graph per session (sessionStorage) so a user who deliberately
 * switches back to Published isn't yanked into a draft again. No-ops entirely for
 * non-blank graphs, published models (mainHeadCommitSeq > 1), read-only users, or
 * when a draft is already active.
 */
import { useEffect } from 'react'
import { usePermission } from '@/store/auth'
import { useBranchStore, useEffectiveBranchId } from '@/store/branchStore'
import { useResolveGraph } from '../hooks/useVersioning'
import { ensureDraftOpen } from './ensureDraftOpen'

const sessionKey = (graphId: string) => `synodic-auto-draft:${graphId}`

export function useAutoDraftForBlankModel(workspaceId: string | null, dataSourceId: string | null) {
  const resolve = useResolveGraph(workspaceId ?? undefined, dataSourceId)
  const canManage = usePermission('workspace:datasource:manage', workspaceId ?? undefined)
  const branchId = useEffectiveBranchId(workspaceId ?? '', dataSourceId)
  const graphReady = useBranchStore((s) => !!s.graphId)

  const graphId = resolve.data?.graphId ?? null
  const isFreshBlank = resolve.data?.kind === 'blank' && (resolve.data?.mainHeadCommitSeq ?? 0) <= 1

  useEffect(() => {
    if (!graphId || !isFreshBlank || !canManage || branchId) return
    // ensureDraftOpen reads its scope from the branch store — wait until the
    // canvas boot sequence has populated it (graphId set), else it no-ops.
    if (!graphReady) return
    if (sessionStorage.getItem(sessionKey(graphId))) return
    sessionStorage.setItem(sessionKey(graphId), '1')
    void ensureDraftOpen()
  }, [graphId, isFreshBlank, canManage, branchId, graphReady])
}
