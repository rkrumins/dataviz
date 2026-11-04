/**
 * Who may open a past revision of Published on the canvas, and the guard that keeps one the canvas
 * can't draw from being drawn.
 */
import { useEffect } from 'react'
import { useFeature } from '@/store/features'
import { usePermission } from '@/store/auth'
import { useBranchStore } from '@/store/branchStore'
import { useVersioningPanelStore } from '@/store/versioningPanelStore'
import { useNotificationStore } from '@/components/ui/notifications'
import type { RevisionInfo } from '@/services/versioningApiService'

/** The preview is on, and the person reads the data source itself: a view's share link reaches the
 *  graph as it is now, never its history (the server refuses it). */
export function useRevisionViewer(wsId?: string | null): boolean {
  const on = useFeature('revisionViewerEnabled')
  const canRead = usePermission('workspace:datasource:read', wsId ?? undefined)
  return on && canRead
}

/** A revision that isn't one closes back to Published, saying so. One the canvas can't draw — too far
 *  back, or a fork's — closes too, and History opens on its comparison with now, which still reaches
 *  it: nothing at a revision is ever drawn from a read the server would refuse. */
export function useRevisionGuard(seq: number | null, plan: { data?: RevisionInfo; error: unknown }) {
  const status = (plan.error as { status?: number } | null)?.status
  useEffect(() => {
    if (seq == null) return
    if (status === 404) {
      useBranchStore.getState().closeRevision()
      useNotificationStore.getState().add({
        type: 'error', message: `Revision #${seq} isn't in this graph's history. You're on Published.`,
      })
    } else if (plan.data && !plan.data.openable) {
      useBranchStore.getState().closeRevision()
      useVersioningPanelStore.getState().openCompare({
        fromSeq: seq, toSeq: null, notice: plan.data.reason === 'fork' ? 'fork' : 'too_far',
      })
    }
  }, [seq, status, plan.data])
}
