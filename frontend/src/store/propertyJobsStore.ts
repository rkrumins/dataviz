/**
 * propertyJobsStore — the bulk property changes running (or just run) on drafts, and the requests
 * to author one.
 *
 * A change is applied by a job on the server; this keeps which jobs this browser started, what
 * each is (its operation, its target in words) and how it last stood, so the Property Manager can
 * follow it, say how it ended, and pick it up again after a reload — the list is kept in
 * localStorage. `requestOp` is how any surface (a catalog row, the layer menu, a container, a
 * search's matches) opens the one dialog, seeded with what it already knows.
 *
 * And how far each draft's jobs have written, as its counts and catalog are asked again
 * (`writtenEpochs`): moved when a job ends, and while one runs at most every `WRITTEN_EVERY_MS` —
 * a 5M-entity job writes some 500 windows, and each would otherwise re-read them all.
 */
import { useMemo } from 'react'
import { create } from 'zustand'

import { remember, remembered } from '@/services/importExportApiService'
import type { PropertyJob, PropertyJobOp, PropertyOpKind, ValueKind, ValueMapping } from '@/services/versioningApiService'
import type { OpDraft, ScopeMode, TargetPreset } from '@/components/canvas/property-manager/op/opModel'

const STORAGE_KEY = 'property-jobs:v1'
/** Ended jobs kept for the panel — the newest; older ones are forgotten. */
const KEEP_ENDED = 20
/** A job this browser lost track of is forgotten this long after it was lost. */
const KEEP_LOST_MS = 7 * 24 * 60 * 60 * 1000
/** While a job runs, its draft's written epoch moves at most this often. */
const WRITTEN_EVERY_MS = 30_000
/** Progress alone is kept (in localStorage) at most this often: 40 running jobs tick together, and a
 *  reload asks each job afresh anyway. How a job starts, ends or is lost is kept at once. */
export const SAVE_PROGRESS_MS = 2_000

export interface TrackedJob {
  jobId: string
  wsId: string
  graphId: string
  branchId: string
  viewId: string
  op: PropertyJobOp
  /** The target in words ("the children of Orders"). */
  targetLabel: string
  /** `edge`: it changes relationships. */
  entityKind?: 'node' | 'edge'
  startedAt: string
  /** How it last stood. */
  job: PropertyJob | null
  /** It couldn't be followed: since when (the first time), and why. `gone`: the server no longer
   *  has it. `checking`: it is being asked about again. */
  lost?: { at: string; message: string; gone?: boolean; checking?: boolean }
}

/** What a surface knows when it asks for a change: any of it seeds the dialog — a merge, the values
 *  it merges (`map`); a convert, the kind to convert to; a recipe, the whole change (`op`) and where
 *  it is searched (`scopeMode`). */
export interface OpRequest {
  kind?: PropertyOpKind
  key?: string
  target?: TargetPreset
  map?: ValueMapping[]
  toKind?: ValueKind
  op?: Partial<OpDraft>
  scopeMode?: ScopeMode
}

const ENDED = new Set(['completed', 'failed', 'cancelled'])
export const jobEnded = (t: TrackedJob) => !!t.job && ENDED.has(t.job.status)

/** How far a draft's jobs have written, as what reads the draft sees it. */
export interface WrittenEpoch {
  epoch: number
  /** When it last moved (ms). */
  at: number
  /** The job it last moved for, and how many commits that job had written then. */
  jobId: string
  commits: number
}

/** The draft a written epoch is kept for. */
export const draftOf = (graphId: string | null | undefined, branchId: string | null | undefined) => `${graphId ?? ''}|${branchId ?? ''}`

/** `epochs` with the draft of `after` moved on — when its job ended just now, or when it has written
 *  past what the epoch last saw and `WRITTEN_EVERY_MS` has gone by — or `epochs` as it was. */
function written(epochs: Record<string, WrittenEpoch>, before: TrackedJob, after: TrackedJob): Record<string, WrittenEpoch> {
  const draft = draftOf(after.graphId, after.branchId)
  const last = epochs[draft]
  const commits = after.job?.summary?.commits ?? 0
  const now = Date.now()
  const ended = !jobEnded(before) && jobEnded(after)
  const further = commits > (last?.jobId === after.jobId ? last.commits : 0)
  if (!ended && !(further && now - (last?.at ?? 0) >= WRITTEN_EVERY_MS)) return epochs
  return { ...epochs, [draft]: { epoch: (last?.epoch ?? 0) + 1, at: now, jobId: after.jobId, commits } }
}

/** Lost long enough ago to forget. */
const lostForGood = (t: TrackedJob) => !!t.lost && Date.now() - Date.parse(t.lost.at) > KEEP_LOST_MS

function load(): TrackedJob[] {
  try {
    const raw = remembered(STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed)
      ? (parsed as TrackedJob[]).filter((j) => j && typeof j.jobId === 'string' && !lostForGood(j)) : []
  } catch {
    return []
  }
}

function save(jobs: TrackedJob[]) {
  remember(STORAGE_KEY, jobs.length ? JSON.stringify(jobs) : null)
}

interface PropertyJobsState {
  jobs: TrackedJob[]
  /** The dialog open now, and what it was seeded with — null when none is. */
  request: OpRequest | null
  /** Counts requests: each opens the dialog afresh. */
  requestSeq: number
  /** Per draft (`draftOf`), how far its jobs have written. */
  writtenEpochs: Record<string, WrittenEpoch>
  track: (job: TrackedJob) => void
  update: (jobId: string, job: PropertyJob) => void
  /** Its follow failed: it is lost (`gone` when the server no longer has it), until it answers. */
  lose: (jobId: string, message: string, gone?: boolean) => void
  /** Ask about lost jobs again. */
  checkAgain: (jobIds: readonly string[]) => void
  dismiss: (jobId: string) => void
  requestOp: (request?: OpRequest) => void
  consumeRequest: () => OpRequest | null
}

export const usePropertyJobsStore = create<PropertyJobsState>((set, get) => {
  let saving: ReturnType<typeof setTimeout> | null = null
  const write = (jobs: TrackedJob[], also: Partial<PropertyJobsState> = {}, progressOnly = false) => {
    // Running ones always kept (a lost one for a week); of the ended, the newest.
    const running = jobs.filter((j) => !jobEnded(j) && !lostForGood(j))
    const ended = jobs.filter(jobEnded).slice(-KEEP_ENDED)
    const kept = jobs.filter((j) => running.includes(j) || ended.includes(j))
    set({ jobs: kept, ...also })
    if (progressOnly) {
      saving ??= setTimeout(() => { saving = null; save(get().jobs) }, SAVE_PROGRESS_MS)
      return
    }
    if (saving) { clearTimeout(saving); saving = null }
    save(kept)
  }
  return {
    jobs: load(),
    request: null,
    requestSeq: 0,
    writtenEpochs: {},
    track: (job) => write([...get().jobs.filter((j) => j.jobId !== job.jobId), job]),
    update: (jobId, job) => {
      const jobs = get().jobs
      const before = jobs.find((j) => j.jobId === jobId)
      if (!before) return
      // An answer: it is followed again, whatever was lost.
      const after = { ...before, job, lost: undefined }
      write(jobs.map((j) => (j.jobId === jobId ? after : j)), { writtenEpochs: written(get().writtenEpochs, before, after) },
        before.job?.status === job.status && !before.lost)
    },
    lose: (jobId, message, gone = false) => write(get().jobs.map((j) => (j.jobId === jobId
      ? { ...j, lost: { at: j.lost?.at ?? new Date().toISOString(), message, ...(gone ? { gone } : {}) } } : j))),
    checkAgain: (jobIds) => {
      const asked = new Set(jobIds)
      if (!get().jobs.some((j) => asked.has(j.jobId) && j.lost && !j.lost.checking)) return
      write(get().jobs.map((j) => (asked.has(j.jobId) && j.lost ? { ...j, lost: { ...j.lost, checking: true } } : j)))
    },
    dismiss: (jobId) => write(get().jobs.filter((j) => j.jobId !== jobId)),
    requestOp: (request = {}) => set((s) => ({ request, requestSeq: s.requestSeq + 1 })),
    consumeRequest: () => {
      const request = get().request
      if (request) set({ request: null })
      return request
    },
  }
})

/** The jobs on this draft, oldest first. */
export function useDraftPropertyJobs(graphId: string | null | undefined, branchId: string | null | undefined): TrackedJob[] {
  const jobs = usePropertyJobsStore((s) => s.jobs)
  return useMemo(
    () => (graphId && branchId ? jobs.filter((j) => j.graphId === graphId && j.branchId === branchId) : []),
    [jobs, graphId, branchId],
  )
}

/** Per property, what the draft's jobs do to it — for the catalog's rows. */
export interface CatalogOverlayEntry {
  kinds: Set<PropertyOpKind>
  /** The new name, for a rename or a copy. */
  renameTo?: string
  /** How many jobs touch it. */
  count: number
  /** One of them is still running. */
  running: boolean
}

export function usePropertyCatalogOverlay(jobs: readonly TrackedJob[]): ReadonlyMap<string, CatalogOverlayEntry> {
  return useMemo(() => {
    const map = new Map<string, CatalogOverlayEntry>()
    // An undo, and a change it has undone, leave the property as it was.
    const undone = new Set(jobs.filter((t) => t.op.kind === 'undo' && t.job?.status === 'completed').map((t) => t.op.sourceJobId))
    for (const t of jobs) {
      if (t.job?.status === 'failed' || t.job?.status === 'cancelled') continue
      if (t.entityKind === 'edge') continue                 // the catalog lists entities' properties
      if (t.op.kind === 'undo' || undone.has(t.jobId) || t.job?.summary?.undoneBy) continue
      const entry = map.get(t.op.key) ?? { kinds: new Set<PropertyOpKind>(), count: 0, running: false }
      entry.kinds.add(t.op.kind)
      entry.count += 1
      entry.running ||= !jobEnded(t)
      if ((t.op.kind === 'rename' || t.op.kind === 'copy') && t.op.to) entry.renameTo = t.op.to
      map.set(t.op.key, entry)
    }
    return map
  }, [jobs])
}
