/**
 * useImportRun — one import, followed to its end: the file goes up in parts (`importInParts`,
 * which resumes an upload of the same file), the job is followed until it ends (`pollJob`), and a
 * finished one that changed anything has a preview of its rows read (`getImportPreview`).
 *
 * A job that failed or was cancelled on the server ends as a failure that says why, never as a
 * finished import. Leaving (unmounting) stops the upload in flight and stops following the job,
 * which carries on on the server.
 *
 * The recoveries read a failed (or finished) job: a replace the replace guard held (`blocked`),
 * a replace held for the rows it refused (`heldForRows`), and rows a property alone couldn't find
 * that their urn would (`byUrnFix`).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getImport, getImportPreview, importInParts, pollJob,
  type CreateImportOptions, type ImportPreviewRow, type ImportSummary, type Job, type RefusedRows,
} from '@/services/importExportApiService'
import { formatIdentifier, parseIdentifier } from './identifier'

export type RunPhase = 'idle' | 'running' | 'done' | 'failed'

/** The graph an import goes into. */
export interface ImportTarget {
  wsId: string
  graphId: string
}

const summaryOf = (job: Job | null) => job?.summary as ImportSummary | null | undefined

/** A replace the replace guard refused: nothing deleted, its rows on the draft. */
export function blocked(job: Job | null): boolean {
  return summaryOf(job)?.failure?.code === 'mass_delete_blocked'
}

/** The rows a job refused, as its summary reports them, if any were. */
export function refusedOf(job: Job | null): RefusedRows | null {
  return summaryOf(job)?.refused ?? null
}

/** A replace held because rows of its file were refused: nothing deleted, its other rows on the draft. */
export function heldForRows(job: Job | null): boolean {
  return summaryOf(job)?.failure?.code === 'rows_refused'
}

/** For a job matched by a property alone whose refused rows have a urn but not the property: the
 *  identifier that finds them by their urn (`prop.<name>,urn`); else null. */
export function byUrnFix(job: Job | null): string | null {
  const ident = job?.identifier
  const hasUrn = refusedOf(job)?.hints?.by_urn ?? 0
  if (!ident || !hasUrn) return null
  const m = parseIdentifier(ident)
  return m.kind === 'prop' && !m.orUrn ? formatIdentifier({ ...m, orUrn: true }) : null
}

/** Why a job failed, in words a person can act on. A file over the row ceiling says the ceiling. */
export function failureText(job: Job): string {
  const failure = summaryOf(job)?.failure
  if (failure?.code === 'too_many_rows' || job.errorMessage?.startsWith('too_many_rows')) {
    const limit = failure?.limit ?? Number(/\d[\d,]*/.exec(job.errorMessage ?? '')?.[0].replace(/,/g, ''))
    return `This file has more rows than an import here may carry${Number.isFinite(limit) ? ` (${limit.toLocaleString()})` : ''}. `
      + 'Split it into smaller files and import them one after another.'
  }
  return job.errorMessage || (job.status === 'cancelled' ? 'The import was cancelled.' : 'The import could not be completed.')
}

export function useImportRun() {
  const [phase, setPhase] = useState<RunPhase>('idle')
  const [job, setJob] = useState<Job | null>(null)
  const [resultBranch, setResultBranch] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [previewRows, setPreviewRows] = useState<ImportPreviewRow[]>([])
  const [upload, setUpload] = useState<{ sent: number; total: number } | null>(null)
  const run = useRef<AbortController | null>(null)
  useEffect(() => () => run.current?.abort(), [])

  /** Import `file` into `target`; resolves with the job as it ended (null when it never started,
   *  or this was left). */
  const start = useCallback(async (target: ImportTarget, file: File, options: CreateImportOptions): Promise<Job | null> => {
    setPhase('running')
    setError(null)
    setPreviewRows([])
    setJob(null)
    setUpload(null)
    const ctl = new AbortController()
    run.current = ctl
    try {
      const created = await importInParts(target.wsId, target.graphId, file, {
        ...options, signal: ctl.signal, onProgress: (sent, total) => setUpload({ sent, total }),
      })
      setResultBranch(created.branchId)
      const done = await pollJob(() => getImport(target.wsId, target.graphId, created.jobId), { onTick: setJob, signal: ctl.signal })
      setJob(done)
      if (done.status === 'failed' || done.status === 'cancelled') {
        setError(failureText(done))
        setPhase('failed')
        return done
      }
      setPhase('done')
      // A sample of what it staged — added, updated, deleted — and of what couldn't be applied, with why.
      const sum = done.summary as ImportSummary | undefined
      if (sum && sum.new + sum.updated + sum.deleted + sum.invalid > 0) {
        getImportPreview(target.wsId, target.graphId, created.jobId)
          .then((p) => setPreviewRows(p.sample))
          .catch(() => {})
      }
      return done
    } catch (e) {
      if (ctl.signal.aborted) return null            // left
      setError(e instanceof Error ? e.message : 'The import could not be completed.')
      setPhase('failed')
      return null
    }
  }, [])

  /** Back to before it started (the job is kept by the server). */
  const reset = useCallback(() => {
    setPhase('idle')
    setJob(null)
    setError(null)
    setPreviewRows([])
    setUpload(null)
  }, [])

  return { phase, job, resultBranch, error, previewRows, upload, start, reset }
}

export type ImportRun = ReturnType<typeof useImportRun>
