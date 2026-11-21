/**
 * useCanvasPropertyJobs — a canvas's bulk property changes, the same on every canvas: the draft a
 * change is written to while the canvas can write (`graphWrite`, for `PropertyOpHost`), and the
 * draft's jobs followed to the end (across a reload). The canvas is re-read once one lands —
 * unless staged edits wait, which a re-read would not lose but the reader may want to finish first.
 */
import { useCallback, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAppNotifications } from '@/components/ui/notifications'
import type { GraphWrite } from '@/components/canvas/property-manager/op/PropertyOpDialog'
import { propertyJobLabel } from '@/components/canvas/property-manager/op/opModel'
import { releaseProviderCaches } from '@/providers/providerPool'
import type { PropertyJob } from '@/services/versioningApiService'
import { useBranchStore } from '@/store/branchStore'
import type { TrackedJob } from '@/store/propertyJobsStore'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { VERSIONING_KEYS } from '../hooks/useVersioning'
import { usePropertyJobs } from '../hooks/usePropertyJobs'

export function useCanvasPropertyJobs({ wsId, graphId, branchId, writable }: {
  wsId: string | null | undefined
  graphId: string | null | undefined
  branchId: string | null | undefined
  /** The canvas can write to the draft now (edit mode, a draft it may write, no trace). */
  writable: boolean
}): GraphWrite | null {
  const { notify } = useAppNotifications()
  const queryClient = useQueryClient()
  const graphWrite = useMemo(() => (writable && wsId && graphId && branchId
    ? { wsId, graphId, branchId } : null), [writable, wsId, graphId, branchId])
  const onEnded = useCallback((tracked: TrackedJob, job: PropertyJob) => {
    const what = propertyJobLabel(tracked.op)
    if (job.status === 'cancelled') {
      notify('info', `${what} was stopped — what it had already changed stays on your draft.`)
      return
    }
    if (job.status === 'failed') {
      const why = typeof job.error === 'string' ? job.error : job.error?.message
      notify('error', `${what} stopped${why ? `: ${why}` : ''}. What it had already changed stays on your draft.`)
      return
    }
    const changed = job.summary?.changed ?? 0
    // The write gate's own refusals; the rest of `refused` were left alone (or not in the draft).
    const refused = job.summary?.refused?.byReason?.write_refused ?? 0
    const message = `${what}: ${changed.toLocaleString()} ${changed === 1 ? 'entity' : 'entities'} changed on your draft`
      + (refused ? ` — ${refused.toLocaleString()} couldn’t be; Property Manager says why.` : '.')
    const reread = () => {
      queryClient.invalidateQueries({ queryKey: VERSIONING_KEYS.all })
      releaseProviderCaches()
      useBranchStore.getState().bumpDraftEpoch()
      useBranchStore.getState().setCommittedDiffHidden(false)
    }
    if (useStagedChangesStore.getState().changes.length === 0) {
      reread()
      notify(refused ? 'warning' : 'success', message,
        { label: 'Review changes', onClick: () => useStagedChangesStore.getState().openReviewPanel('saved') })
    } else {
      notify('info', `${message} Refresh the canvas to see it — your staged changes stay staged.`, { label: 'Refresh canvas', onClick: reread })
    }
  }, [notify, queryClient])
  usePropertyJobs(wsId, graphId, branchId, onEnded)
  return graphWrite
}
