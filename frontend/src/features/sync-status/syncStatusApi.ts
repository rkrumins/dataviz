/**
 * Is what a view reads in sync with where it comes from? One read for both kinds of graph:
 * a VERSIONED (managed) graph reports the system of record's published head against the version
 * the graph holds, with both revisions; an EXTERNAL graph reports when the app last checked it and
 * last caught up. Both report the lineage summaries and the automation keeping them current, and
 * whether search works on the data.
 * Served by the graph router, so anyone who can open the view can read it (`viewId` carries that).
 */
import { authFetch } from '@/services/apiClient'

export interface SyncRevision {
  commitId: string
  createdAt?: string | null
  actor?: string | null
  actorName?: string | null
  message?: string | null
}

export interface SyncVersioned {
  graphId: string
  committed: number
  projected: number
  fresh: boolean
  status: 'idle' | 'projecting' | 'rebuilding' | 'evicted' | string
  lastError?: string | null
  lastProjectedAt?: string | null
  progressDone?: number | null
  progressTotal?: number | null
  committedRevision?: SyncRevision | null
  projectedRevision?: SyncRevision | null
}

export interface SyncSummaries {
  aggregationStatus?: string | null
  lastBuiltAt?: string | null
  jobId?: string | null
  jobStatus?: 'pending' | 'running' | string | null
  jobProgress?: number | null
  jobPhase?: string | null
  jobStartedAt?: string | null
  driftState?: string | null
  autoRefresh?: boolean | null
  cooldownUntil?: string | null
  pausedUntil?: string | null
  lastFailureReason?: string | null
  /** An operator hold: the automation evaluates but does not act while one is in force. */
  heldKind?: 'stopped' | 'paused' | string | null
  heldBy?: 'fleet' | 'provider' | 'source' | string | null
  heldUntil?: string | null
  /** The newest job's outcome and when — a failure is always shown with its date. */
  lastJobStatus?: 'completed' | 'failed' | 'cancelled' | 'running' | 'pending' | string | null
  lastJobAt?: string | null
  /** When the summaries were last built successfully. */
  lastSuccessAt?: string | null
}

export interface SyncCounts {
  nodes: number
  /** Raw connections (rollups excluded). */
  edges: number
  /** When the stats service last actually read these from the graph. */
  readAt?: string | null
}

export interface SyncSource {
  lastCheckedAt?: string | null
  lastReconciledAt?: string | null
  lastReconcileReason?: string | null
  checkIntervalSecs?: number | null
  staleSince?: string | null
  staleReason?: string | null
  /** Computed live: have the source's counts moved since the last refresh? null = can't tell. */
  changedSinceRefresh?: boolean | null
}

export interface SyncSearch {
  /** Only FalkorDB runs search; another graph store has none. */
  supported: boolean
  /** Is the graph store answering — from real traffic, else the background probe. */
  status: 'ready' | 'unavailable' | 'unknown' | string
  /** Where a node without a displayName is named from — what a name search matches for it
   *  (the data source's Display-name property). */
  nameProperty?: string | null
  /** When that was observed. */
  checkedAt?: string | null
  /** The latest search of this data source: when, whether it answered, and why not. */
  lastSearchAt?: string | null
  lastSearchOk?: boolean | null
  lastSearchReason?: string | null
}

export interface SyncStatus {
  kind: 'versioned' | 'external'
  dataSourceId: string
  checkedAt: string
  versioned?: SyncVersioned | null
  source?: SyncSource | null
  summaries?: SyncSummaries | null
  counts?: SyncCounts | null
  search?: SyncSearch | null
}

export function getSyncStatus(wsId: string, dataSourceId: string, viewId?: string): Promise<SyncStatus> {
  const q = new URLSearchParams({ dataSourceId })
  if (viewId) q.set('viewId', viewId)
  return authFetch<SyncStatus>(`/api/v1/${encodeURIComponent(wsId)}/graph/sync-status?${q}`, { silent403: true })
}
