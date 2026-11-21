/**
 * propertyJobsStore — the bulk property changes running (or just run) on drafts, and the requests
 * to author one.
 *
 * A change is applied by a job on the server; this keeps which jobs this browser started, what
 * each is (its operation, its target in words) and how it last stood, so the Property Manager can
 * follow it, say how it ended, and pick it up again after a reload — the list is kept in
 * localStorage. `requestOp` is how any surface (a catalog row, the layer menu, a container, a
 * search's matches) opens the one dialog, seeded with what it already knows.
 */
import { useMemo } from 'react'
import { create } from 'zustand'

import { remember, remembered } from '@/services/importExportApiService'
import type { PropertyJob, PropertyJobOp, PropertyOpKind, ValueKind, ValueMapping } from '@/services/versioningApiService'
import type { OpDraft, ScopeMode, TargetPreset } from '@/components/canvas/property-manager/op/opModel'

const STORAGE_KEY = 'property-jobs:v1'
/** Ended jobs kept for the panel — the newest; older ones are forgotten. */
const KEEP_ENDED = 20

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

function load(): TrackedJob[] {
  try {
    const raw = remembered(STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed) ? (parsed as TrackedJob[]).filter((j) => j && typeof j.jobId === 'string') : []
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
  track: (job: TrackedJob) => void
  update: (jobId: string, job: PropertyJob) => void
  dismiss: (jobId: string) => void
  requestOp: (request?: OpRequest) => void
  consumeRequest: () => OpRequest | null
}

export const usePropertyJobsStore = create<PropertyJobsState>((set, get) => {
  const write = (jobs: TrackedJob[]) => {
    // Running ones always kept; of the ended, the newest.
    const running = jobs.filter((j) => !jobEnded(j))
    const ended = jobs.filter(jobEnded).slice(-KEEP_ENDED)
    const kept = jobs.filter((j) => running.includes(j) || ended.includes(j))
    save(kept)
    set({ jobs: kept })
  }
  return {
    jobs: load(),
    request: null,
    requestSeq: 0,
    track: (job) => write([...get().jobs.filter((j) => j.jobId !== job.jobId), job]),
    update: (jobId, job) => {
      const jobs = get().jobs
      if (!jobs.some((j) => j.jobId === jobId)) return
      write(jobs.map((j) => (j.jobId === jobId ? { ...j, job } : j)))
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
    for (const t of jobs) {
      if (t.job?.status === 'failed' || t.job?.status === 'cancelled') continue
      if (t.entityKind === 'edge') continue                 // the catalog lists entities' properties
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
