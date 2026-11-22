/**
 * usePropertyJobs — follow the draft's bulk property jobs to the end: each running job this
 * browser started (kept across a reload) is asked how it stands until it ends — through blips,
 * paused while the tab is hidden — and `onEnded` hears how it ended, once.
 *
 * A follow that fails for good (the server unreachable past the poll's patience, or the job gone)
 * marks the job lost rather than leaving it "running" forever; a lost job is asked about again
 * when the browser is back online, the tab is shown or the window is focused.
 */
import { useEffect, useRef } from 'react'
import { httpStatusOf } from '@/services/graphRequestFailure'
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
  const running = jobs.filter((j) => !jobEnded(j) && (!j.lost || j.lost.checking)).map((j) => j.jobId).join(',')
  // Lost, but maybe only for now: asked about again on the next sign of life.
  const lost = jobs.filter((j) => !jobEnded(j) && j.lost && !j.lost.gone && !j.lost.checking).map((j) => j.jobId).join(',')

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
        .catch((err: unknown) => {
          if (controller.signal.aborted) return
          const gone = httpStatusOf(err) === 404
          usePropertyJobsStore.getState().lose(jobId,
            gone ? 'the server no longer has it' : (err as Error).message || 'the server didn’t answer', gone)
        })
    }
    return () => controller.abort()
  }, [wsId, graphId, running])

  useEffect(() => {
    if (!lost) return
    const again = () => {
      if (document.visibilityState === 'hidden') return
      usePropertyJobsStore.getState().checkAgain(lost.split(','))
    }
    window.addEventListener('online', again)
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)
    return () => {
      window.removeEventListener('online', again)
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', again)
    }
  }, [lost])

  return jobs
}
