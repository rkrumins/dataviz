/**
 * useBootstrapWatch — the enablement job as the two surfaces that show it need it
 * (the canvas strip and the data-source tab), so they can never disagree.
 *
 * The subtle part is the RECEIPT. When the copy finishes, the graph becomes versioned
 * and `needsSeed` flips false — which would whisk the integrity report away in the very
 * frame the user earned it. So we latch onto a job we watched run, keep showing its
 * report until the user dismisses it, and only then hand over to the normal versioning
 * UI. Someone arriving later at an already-versioned graph sees none of this (the query
 * is disabled), which is right: the receipt belongs to whoever ran the copy.
 */
import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { VERSIONING_KEYS, useBootstrapStatus } from '../hooks/useVersioning'
import type { BootstrapJob } from '@/services/versioningApiService'

export function useBootstrapWatch(
  wsId: string,
  dataSourceId: string | null,
  { headSeq, seed }: { headSeq: number; seed?: BootstrapJob | null },
) {
  const qc = useQueryClient()
  const [watching, setWatching] = useState(false)
  const [reportDismissed, setReportDismissed] = useState(false)

  const q = useBootstrapStatus(wsId, dataSourceId, {
    // Only a not-yet-versioned source can have a live job — except while we're holding
    // the receipt open for the person who just ran one.
    enabled: headSeq <= 1 || watching,
    seed: seed ?? undefined,
  })
  const job = q.data ?? null
  const active = job?.status === 'pending' || job?.status === 'running'

  useEffect(() => {
    if (active) setWatching(true)
  }, [active])

  // The moment it lands the graph is live: refresh everything that was still rendering
  // this data source as un-versioned (resolve, branches, history).
  useEffect(() => {
    if (watching && job?.status === 'completed') {
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.all })
    }
  }, [watching, job?.status, qc])

  return {
    job,
    /** A copy is running, or it stopped and needs a decision. */
    showProgress: !!job && (active || job.status === 'failed'),
    /** The integrity report, for whoever ran the copy, until they dismiss it. */
    showReport: !!job && job.status === 'completed' && watching && !reportDismissed,
    dismissReport: () => setReportDismissed(true),
  }
}
