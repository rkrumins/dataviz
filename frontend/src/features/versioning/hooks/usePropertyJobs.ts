/**
 * usePropertyJobs — follow the draft's bulk property jobs to the end: each running job this
 * browser started (kept across a reload) is asked how it stands until it ends — through blips,
 * paused while the tab is hidden — and `onEnded` hears how it ended, once.
 */
import { useEffect, useRef } from 'react'
import { followPropertyJob, type PropertyJob } from '@/services/versioningApiService'
import { jobEnded, useDraftPropertyJobs, usePropertyJobsStore, type TrackedJob } from '@/store/propertyJobsStore'

const ENDED = new Set(['completed', 'failed', 'cancelled'])

export function usePropertyJobs(
  wsId: string | null | undefined,
  graphId: string | null | undefined,
  branchId: string | null | undefined,
  onEnded: (tracked: TrackedJob, job: PropertyJob) => void,
): TrackedJob[] {
  const jobs = useDraftPropertyJobs(graphId, branchId)
  const onEndedRef = useRef(onEnded)
  useEffect(() => { onEndedRef.current = onEnded }, [onEnded])
  const running = jobs.filter((j) => !jobEnded(j)).map((j) => j.jobId).join(',')

  useEffect(() => {
    if (!wsId || !graphId || !running) return
    const controller = new AbortController()
    for (const jobId of running.split(',')) {
      const store = usePropertyJobsStore.getState()
      // Progress is kept as it comes; the end is kept below, where it is also announced — kept
      // here, it would end this follow before the announcement.
      followPropertyJob(wsId, graphId, jobId, (job) => { if (!ENDED.has(job.status)) store.update(jobId, job) }, controller.signal)
        .then((job) => {
          if (controller.signal.aborted) return
          const tracked = usePropertyJobsStore.getState().jobs.find((j) => j.jobId === jobId)
          store.update(jobId, job)
          if (tracked) onEndedRef.current(tracked, job)
        })
        .catch(() => { /* aborted, or the job can't be read: it stays as it last stood */ })
    }
    return () => controller.abort()
  }, [wsId, graphId, running])

  return jobs
}
