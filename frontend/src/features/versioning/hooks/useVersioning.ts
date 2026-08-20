/**
 * React Query hooks for the versioning surface — queries + lifecycle mutations,
 * with the invalidation fan-out that keeps the BranchSwitcher, diff overlay, and
 * history in sync after a save / publish / merge.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '@/services/versioningApiService'
import type { ResolutionMap, StageOp } from '@/services/versioningApiService'
import { invalidateAggregatedEdges } from '@/hooks/useAggregatedLineage'
import { useBranchStore } from '@/store/branchStore'
import { findLivePrForBranch, isTerminalPr } from '../model/prStatus'
import { recordEvent } from '@/services/telemetryService'

export const VERSIONING_KEYS = {
  all: ['versioning'] as const,
  // `viewId` is appended only when given, so callers not yet threaded a view (data-source-level
  // consumers) keep the exact same cache key as before — no unintended cache-key churn/refetch.
  resolve: (ws?: string, ds?: string | null, viewId?: string | null) =>
    viewId
      ? ([...VERSIONING_KEYS.all, 'resolve', ws, ds, viewId] as const)
      : ([...VERSIONING_KEYS.all, 'resolve', ws, ds] as const),
  // `viewId` is appended only when given, so graph-wide callers keep their existing cache key.
  branches: (ws?: string, gid?: string | null, viewId?: string | null) =>
    viewId
      ? ([...VERSIONING_KEYS.all, 'branches', ws, gid, viewId] as const)
      : ([...VERSIONING_KEYS.all, 'branches', ws, gid] as const),
  branchState: (ws?: string, gid?: string | null, bid?: string | null) =>
    [...VERSIONING_KEYS.all, 'state', ws, gid, bid] as const,
  branchFreshness: (ws?: string, gid?: string | null, bid?: string | null) =>
    [...VERSIONING_KEYS.all, 'branchFreshness', ws, gid, bid] as const,
  diffVsMain: (ws?: string, gid?: string | null, bid?: string | null) =>
    [...VERSIONING_KEYS.all, 'diffVsMain', ws, gid, bid] as const,
  commitLog: (ws?: string, gid?: string | null, bid?: string | null) =>
    [...VERSIONING_KEYS.all, 'commits', ws, gid, bid ?? 'all'] as const,
  entityHistory: (ws?: string, gid?: string | null, eid?: string | null) =>
    [...VERSIONING_KEYS.all, 'entity', ws, gid, eid] as const,
  mergeRequests: (ws?: string, gid?: string | null) =>
    [...VERSIONING_KEYS.all, 'mrs', ws, gid] as const,
  mergeRequest: (ws?: string, prId?: string | null) =>
    [...VERSIONING_KEYS.all, 'mr', ws, prId] as const,
  prDiff: (ws?: string, prId?: string | null) =>
    [...VERSIONING_KEYS.all, 'prDiff', ws, prId] as const,
  prPreview: (ws?: string, prId?: string | null) =>
    [...VERSIONING_KEYS.all, 'prPreview', ws, prId] as const,
  prDiffSummary: (ws?: string, prId?: string | null) =>
    [...VERSIONING_KEYS.all, 'prDiffSummary', ws, prId] as const,
  branchDiffSummary: (ws?: string, gid?: string | null, bid?: string | null) =>
    [...VERSIONING_KEYS.all, 'branchDiffSummary', ws, gid, bid] as const,
  commitDiffSummary: (ws?: string, gid?: string | null, cid?: string | null) =>
    [...VERSIONING_KEYS.all, 'commitDiffSummary', ws, gid, cid] as const,
  viewPrs: (ws?: string, viewId?: string | null, status?: string | null) =>
    [...VERSIONING_KEYS.all, 'viewPrs', ws, viewId, status ?? 'all'] as const,
  dataSourcePrs: (ws?: string, dsId?: string | null, status?: string | null) =>
    [...VERSIONING_KEYS.all, 'dataSourcePrs', ws, dsId, status ?? 'all'] as const,
  viewPrCounts: (ws?: string, viewId?: string | null) =>
    [...VERSIONING_KEYS.all, 'viewPrCounts', ws, viewId] as const,
  viewCommitLog: (ws?: string, gid?: string | null, viewId?: string | null, graphWide?: boolean, limit?: number) =>
    [...VERSIONING_KEYS.all, 'viewCommits', ws, gid, viewId, !!graphWide, limit ?? 'default'] as const,
  squashedCommits: (ws?: string, gid?: string | null, cid?: string | null) =>
    [...VERSIONING_KEYS.all, 'squashed', ws, gid, cid] as const,
  projectionWatermark: (ws?: string, gid?: string | null) =>
    [...VERSIONING_KEYS.all, 'watermark', ws, gid] as const,
  restorePreview: (ws?: string, gid?: string | null, cid?: string | null) =>
    [...VERSIONING_KEYS.all, 'restorePreview', ws, gid, cid] as const,
  bootstrap: (ws?: string, ds?: string | null) =>
    [...VERSIONING_KEYS.all, 'bootstrap', ws, ds] as const,
}

// ── Queries ────────────────────────────────────────────────────────────────

/** Resolve a data source → its graph + the caller's open draft. The switcher's spine. Pass
 *  `viewId` (the active Context View) to scope the draft lookup to that view (branch-per-view). */
export function useResolveGraph(wsId?: string, dataSourceId?: string | null, viewId?: string | null) {
  return useQuery({
    queryKey: VERSIONING_KEYS.resolve(wsId, dataSourceId, viewId),
    queryFn: () => api.resolveGraph(wsId!, dataSourceId!, viewId),
    enabled: !!wsId && !!dataSourceId,
    // 5 min: a data source's versioned-graph existence changes rarely, but
    // ≥8 components mount this hook during canvas load — a 30s window let a
    // burst of identical 404s re-fire on every remount/invalidation. Long
    // staleTime collapses them to one lookup per scope per 5 min.
    staleTime: 300_000,
    gcTime: 300_000,
    // Don't retry terminal cases only: a 404 (no versioned graph for this data
    // source) or an explicit provider-down code. R-M1: do NOT match the bare
    // words "unavailable"/"timed out" — those also catch a 503 "Service
    // Unavailable" from a rolling deploy / restarting pod, which IS retryable.
    retry: (n, e) =>
      !/404|not found|provider_(unavailable|loading)/i.test(
        String((e as Error)?.message),
      ) && n < 2,
  })
}

/** Branches on a graph. Omit `viewId` for the graph-wide (Data-Source) list; pass the active
 *  Context View's id to list only THAT view's branches (branch-per-view — what the switcher shows). */
export function useBranches(wsId?: string, graphId?: string | null, viewId?: string | null) {
  return useQuery({
    queryKey: VERSIONING_KEYS.branches(wsId, graphId, viewId),
    queryFn: () => api.listBranches(wsId!, graphId!, { viewId }),
    enabled: !!wsId && !!graphId,
    staleTime: 15_000,
  })
}

export function useBranchState(wsId?: string, graphId?: string | null, branchId?: string | null) {
  return useQuery({
    queryKey: VERSIONING_KEYS.branchState(wsId, graphId, branchId),
    queryFn: () => api.getBranchState(wsId!, graphId!, branchId!),
    enabled: !!wsId && !!graphId && !!branchId,
    staleTime: 10_000,
  })
}

/** Poll a graph's projection freshness; drives the "refreshing…" badge. Polls every 3s ONLY while a
 *  projection is actively catching up (status projecting/rebuilding), then stops. A graph that is
 *  merely behind-and-idle (no FalkorDB worker running) is not polled — otherwise it would poll
 *  forever. A merge/publish invalidates this query, so a freshly-started projection is picked up.
 *  `opts.force` keeps the poll alive REGARDLESS of status — the Data health rebuild flow needs to
 *  observe the terminal transition (idle + lastError = failed), which the status-gated poll would
 *  stop one tick short of. */
export function useProjectionWatermark(
  wsId?: string, graphId?: string | null, opts?: { force?: boolean },
) {
  const force = opts?.force ?? false
  return useQuery({
    queryKey: VERSIONING_KEYS.projectionWatermark(wsId, graphId),
    queryFn: () => api.getWatermark(wsId!, graphId!),
    enabled: !!wsId && !!graphId,
    refetchInterval: (q) => {
      if (force) return 3_000
      const d = q.state.data
      const active = d?.status === 'projecting' || d?.status === 'rebuilding'
      return d && d.fresh === false && active ? 3_000 : false
    },
    staleTime: 2_000,
    refetchOnWindowFocus: false,
  })
}

/** Live "is this draft behind main?" — the "notified right away" signal. Isolated by design: its OWN
 *  query key (never shared), a CONSTANT poll interval (not a function that can thrash), and it only
 *  runs while a draft is open (`enabled` on branchId). Structurally cannot cause a render loop. */
export function useBranchFreshness(wsId?: string, graphId?: string | null, branchId?: string | null) {
  return useQuery({
    queryKey: VERSIONING_KEYS.branchFreshness(wsId, graphId, branchId),
    queryFn: () => api.getBranchFreshness(wsId!, graphId!, branchId!),
    enabled: !!wsId && !!graphId && !!branchId,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  })
}

export function useDiffVsMain(wsId?: string, graphId?: string | null, branchId?: string | null) {
  return useQuery({
    queryKey: VERSIONING_KEYS.diffVsMain(wsId, graphId, branchId),
    queryFn: () => api.getDiffVsMain(wsId!, graphId!, branchId!),
    enabled: !!wsId && !!graphId && !!branchId,
    staleTime: 10_000,
  })
}

export function useCommitLog(wsId?: string, graphId?: string | null, branchId?: string | null) {
  return useQuery({
    queryKey: VERSIONING_KEYS.commitLog(wsId, graphId, branchId),
    queryFn: () => api.getCommitLog(wsId!, graphId!, branchId ? { branchId } : {}),
    enabled: !!wsId && !!graphId,
    staleTime: 15_000,
  })
}

export function useEntityHistory(wsId?: string, graphId?: string | null, entityId?: string | null) {
  return useQuery({
    queryKey: VERSIONING_KEYS.entityHistory(wsId, graphId, entityId),
    queryFn: () => api.getEntityHistory(wsId!, graphId!, entityId!),
    enabled: !!wsId && !!graphId && !!entityId,
    staleTime: 30_000,
  })
}

export function useMergeRequests(wsId?: string, graphId?: string | null) {
  return useQuery({
    queryKey: VERSIONING_KEYS.mergeRequests(wsId, graphId),
    queryFn: () => api.listMergeRequests(wsId!, graphId!),
    enabled: !!wsId && !!graphId,
    staleTime: 15_000,
  })
}

/** The open review for `branchId`, if there is one — at most one can exist (the backend enforces
 *  "one live PR per source branch"). This is what lets a surface ask "is this branch already in
 *  review?" instead of blindly offering to raise another PR. `pending` matters: until the list has
 *  loaded we don't yet know, and callers must not act as though the answer is "no". */
export function useLivePrForBranch(wsId?: string, graphId?: string | null, branchId?: string | null) {
  const q = useMergeRequests(wsId, graphId)
  return {
    livePr: findLivePrForBranch(q.data, branchId),
    pending: q.isPending,
  }
}

/** One PR's detail (works for draft MRs and fork PRs — the endpoint dispatches).
 *
 *  Polled while LIVE only. A PR is a collaborative surface: someone else can merge and move `main`
 *  while this drawer sits open, which flips the server's `behind` flag — the very thing that gates
 *  the Merge button. Without a poll the reviewer sits on a stale PR and gets a surprise 409. A
 *  terminal (merged/closed) PR is immutable, so polling it is pure waste — hence the condition, the
 *  same shape `useProjectionWatermark` uses. */
export function useMergeRequest(wsId?: string, prId?: string | null) {
  return useQuery({
    queryKey: VERSIONING_KEYS.mergeRequest(wsId, prId),
    queryFn: () => api.getMergeRequest(wsId!, prId!),
    enabled: !!wsId && !!prId,
    staleTime: 10_000,
    refetchInterval: (q) => (isTerminalPr(q.state.data?.status) ? false : 20_000),
    refetchOnWindowFocus: true,
  })
}

/** The renderable diff of a branch between two seqs. Used for "what came in when I pulled": the
 *  window is main between the draft's old and new base. Immutable history → cache it hard. */
export function useDiffWindow(
  wsId?: string, graphId?: string | null, branchId?: string | null,
  fromSeq?: number | null, toSeq?: number | null,
) {
  const on = !!wsId && !!graphId && !!branchId && fromSeq != null && toSeq != null && toSeq > fromSeq
  return useQuery({
    queryKey: [...VERSIONING_KEYS.all, 'diffWindow', wsId, graphId, branchId, fromSeq, toSeq],
    queryFn: () => api.getDiffWindow(wsId!, graphId!, branchId!, fromSeq!, toSeq!),
    enabled: on,
    staleTime: Infinity,   // a closed commit window never changes
  })
}

/** A PR's itemised Files Changed (for the unified ChangesPanel). */
export function usePullRequestDiff(wsId?: string, prId?: string | null) {
  return useQuery({
    queryKey: VERSIONING_KEYS.prDiff(wsId, prId),
    queryFn: () => api.getMergeRequestDiff(wsId!, prId!),
    enabled: !!wsId && !!prId,
    staleTime: 15_000,
  })
}

/** Pre-merge dry-run: clean flag + conflict set + change counts. */
export function usePreviewMergeRequest(wsId?: string, prId?: string | null) {
  return useQuery({
    queryKey: VERSIONING_KEYS.prPreview(wsId, prId),
    queryFn: () => api.previewMergeRequest(wsId!, prId!),
    enabled: !!wsId && !!prId,
    staleTime: 15_000,
  })
}

// ── Hierarchical diff + view review layer ────────────────────────────────────

/** Top-level groups of a PR's hierarchical Files Changed (children load lazily). */
export function usePrDiffSummary(wsId?: string, prId?: string | null, limit?: number) {
  return useQuery({
    queryKey: VERSIONING_KEYS.prDiffSummary(wsId, prId),
    queryFn: () => api.getMergeRequestDiffSummary(wsId!, prId!, limit),
    enabled: !!wsId && !!prId,
    staleTime: 15_000,
  })
}

/** Top-level groups of a draft's hierarchical diff (the canvas Changes panel). */
export function useBranchDiffSummary(
  wsId?: string, graphId?: string | null, branchId?: string | null, limit?: number,
) {
  return useQuery({
    queryKey: VERSIONING_KEYS.branchDiffSummary(wsId, graphId, branchId),
    queryFn: () => api.getBranchDiffSummary(wsId!, graphId!, branchId!, limit),
    enabled: !!wsId && !!graphId && !!branchId,
    staleTime: 10_000,
  })
}

/** One commit's hierarchical diff — the History tab drill-down (gated on an expanded commit). */
export function useCommitDiffSummary(wsId?: string, graphId?: string | null, commitId?: string | null) {
  return useQuery({
    queryKey: VERSIONING_KEYS.commitDiffSummary(wsId, graphId, commitId),
    queryFn: () => api.getCommitDiffSummary(wsId!, graphId!, commitId!),
    enabled: !!wsId && !!graphId && !!commitId,
    staleTime: 60_000,   // a commit is immutable
  })
}

/** PRs raised from a view. */
export function useViewPullRequests(wsId?: string, viewId?: string | null, status?: string) {
  return useQuery({
    queryKey: VERSIONING_KEYS.viewPrs(wsId, viewId, status),
    queryFn: () => api.listViewPullRequests(wsId!, viewId!, status ? { status } : {}),
    enabled: !!wsId && !!viewId,
    staleTime: 15_000,
  })
}

/** All PRs against a data source (gated — only fetched when the user opts into the wider view). */
export function useDataSourcePullRequests(
  wsId?: string, dataSourceId?: string | null, status?: string, enabled = true,
) {
  return useQuery({
    queryKey: VERSIONING_KEYS.dataSourcePrs(wsId, dataSourceId, status),
    queryFn: () => api.listDataSourcePullRequests(wsId!, dataSourceId!, status ? { status } : {}),
    enabled: !!wsId && !!dataSourceId && enabled,
    staleTime: 15_000,
  })
}

/** Active-PR counts for a view's canvas indicator. */
export function useViewPrCounts(wsId?: string, viewId?: string | null) {
  return useQuery({
    queryKey: VERSIONING_KEYS.viewPrCounts(wsId, viewId),
    queryFn: () => api.getViewPrCounts(wsId!, viewId!),
    enabled: !!wsId && !!viewId,
    staleTime: 20_000,
  })
}

/** A view's change history. "This view" (default) shows the view's PUBLISHED timeline
 *  (its squash-publishes + shared graph-level events) — equal to the whole-graph log for a
 *  single-view source, with each squash drillable via {@link useSquashedCommits}. Graph-wide
 *  shows the full `main` log. */
export function useViewCommitLog(
  wsId?: string, graphId?: string | null,
  opts: { viewId?: string | null; graphWide?: boolean; limit?: number } = {},
) {
  const { viewId, graphWide, limit } = opts
  return useQuery({
    queryKey: VERSIONING_KEYS.viewCommitLog(wsId, graphId, viewId, graphWide, limit),
    queryFn: () =>
      api.getCommitLog(wsId!, graphId!,
        graphWide || !viewId
          ? { limit }
          : { originatingViewId: viewId, publishedOnly: true, limit }),
    enabled: !!wsId && !!graphId && (graphWide || !!viewId),
    staleTime: 15_000,
  })
}

/** The raw draft commits squashed into a publish/merge commit — lazily loaded when the user
 *  expands a "merged N commits" row. Immutable once published, so cache it long. */
export function useSquashedCommits(
  wsId?: string, graphId?: string | null, commitId?: string | null, enabled = true,
) {
  return useQuery({
    queryKey: VERSIONING_KEYS.squashedCommits(wsId, graphId, commitId),
    queryFn: () => api.getSquashedCommits(wsId!, graphId!, commitId!, { limit: 100 }),
    enabled: !!wsId && !!graphId && !!commitId && enabled,
    staleTime: 5 * 60_000,
  })
}

// ── Mutations ────────────────────────────────────────────────────────────────

/** Enable version control for a data source (create-or-seed its versioned graph). */
/** Start the enablement job (202 + jobId). The status poll below takes over from here. */
export function useBootstrapGraph(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dataSourceId: string) => api.bootstrapGraph(wsId, dataSourceId),
    onSuccess: (_res, dataSourceId) => {
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.bootstrap(wsId, dataSourceId) })
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.resolve(wsId, dataSourceId) })
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.all })
    },
  })
}

/** Live progress of the enablement job. Polls ONLY while a job is actually running —
 *  a completed/failed/absent job settles to no network at all (the storm-safe pattern
 *  the projection watermark uses). `seed` renders instantly from /resolve on reload. */
export function useBootstrapStatus(
  wsId?: string, dataSourceId?: string | null,
  opts: { enabled?: boolean; seed?: api.BootstrapJob | null } = {},
) {
  const enabled = (opts.enabled ?? true) && !!wsId && !!dataSourceId
  return useQuery({
    queryKey: VERSIONING_KEYS.bootstrap(wsId, dataSourceId),
    queryFn: () => api.getBootstrapStatus(wsId!, dataSourceId!),
    enabled,
    initialData: opts.seed ?? undefined,
    retry: false,                          // 404 = never started; don't hammer
    refetchInterval: (q) => {
      const s = (q.state.data as api.BootstrapJob | undefined)?.status
      return s === 'pending' || s === 'running' ? 2500 : false
    },
    refetchIntervalInBackground: false,    // a hidden tab doesn't poll
  })
}

/** Resume a failed copy (or start it over) / give up and restore the data source. */
export function useRetryBootstrap(wsId: string, dataSourceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (mode: 'resume' | 'restart' = 'resume') =>
      api.retryBootstrap(wsId, dataSourceId, mode),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.bootstrap(wsId, dataSourceId) })
    },
  })
}

export function useAbandonBootstrap(wsId: string, dataSourceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.abandonBootstrap(wsId, dataSourceId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.bootstrap(wsId, dataSourceId) })
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.all })
    },
  })
}

export function useOpenDraft(wsId: string, graphId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { name?: string; originatingViewId?: string; shared?: boolean } = {}) =>
      api.openDraft(wsId, graphId, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.branches(wsId, graphId) })
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.resolve(wsId) })
    },
  })
}

export function useAbandonDraft(wsId: string, graphId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (branchId: string) => api.abandonDraft(wsId, graphId, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.branches(wsId, graphId) })
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.resolve(wsId) })
    },
  })
}

/** Edit a draft's name / description / shared-visibility. Refreshes the branch list + resolve. */
export function useUpdateBranch(wsId: string, graphId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { branchId: string; name?: string; description?: string; isShared?: boolean }) =>
      api.updateBranch(wsId, graphId, v.branchId, { name: v.name, description: v.description, isShared: v.isShared }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.branches(wsId, graphId) })
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.resolve(wsId) })
    },
  })
}

/** Pull the latest main into a draft ("update branch"). Returns the RebaseResponse so the caller can
 *  open the conflict resolver when `clean === false`; on a clean pull it refreshes the draft views. */
export function usePullLatestDraft(wsId: string, graphId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { branchId: string; resolutions?: ResolutionMap }) =>
      api.rebaseDraft(wsId, graphId, v.branchId, { resolutions: v.resolutions }),
    onSuccess: (res, v) => {
      if (!res.clean) return
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.branches(wsId, graphId) })
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.branchState(wsId, graphId, v.branchId) })
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.diffVsMain(wsId, graphId, v.branchId) })
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.resolve(wsId) })
      // The draft's base advanced — any MR/PR for it is no longer "behind"; refresh PR detail + lists
      // so the merge gate clears.
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.mergeRequests(wsId, graphId) })
      qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'mr'] })
      qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'viewPrs'] })
      qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'dataSourcePrs'] })
    },
  })
}

/** Stage + commit a batch of ops as one draft commit (the "Save" path). */
export function useSaveDraft(wsId: string, graphId: string, branchId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { ops: StageOp[]; message?: string }) =>
      api.saveDraft(wsId, graphId, branchId, v.ops, v.message),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.branchState(wsId, graphId, branchId) })
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.diffVsMain(wsId, graphId, branchId) })
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.commitLog(wsId, graphId, branchId) })
    },
  })
}

/** Every cache that describes a PR's *status*. The view/data-source lists and the indicator counts
 *  are keyed by view/ds — often unknown at the call site — so they go by prefix. Shared by the PR
 *  review actions and by publish (which now resolves the branch's open PR server-side, so the PR
 *  lists are stale the moment it succeeds). */
function invalidatePrScopes(qc: ReturnType<typeof useQueryClient>, wsId: string, graphId?: string | null) {
  if (graphId) qc.invalidateQueries({ queryKey: VERSIONING_KEYS.mergeRequests(wsId, graphId) })
  qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'mr'] })
  qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'viewPrs'] })
  qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'dataSourcePrs'] })
  qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'viewPrCounts'] })
}

export function usePublishBranch(wsId: string, graphId: string) {
  const qc = useQueryClient()
  const bumpMainEpoch = useBranchStore((s) => s.bumpMainEpoch)
  return useMutation({
    mutationFn: (v: { branchId: string; message: string; resolutions?: ResolutionMap }) =>
      api.publishBranch(wsId, graphId, v.branchId, { message: v.message, resolutions: v.resolutions }),
    onSuccess: () => {
      // Version control is a headline feature with no usage signal until now:
      // Analytics could see branches exist, never that anyone shipped one.
      recordEvent('version.published')
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.branches(wsId, graphId) })
      // Refresh ALL commit-log scopes by prefix — the new squash commit must show in History's
      // "This view" / "Whole graph" (viewCommits) and per-branch (commits) lists without a reload.
      qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'commits'] })
      qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'viewCommits'] })
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.resolve(wsId) })
      // Publishing a branch RESOLVES any open review on it (the squash lands exactly what that
      // review proposed). Without this the PR lists kept rendering it as open and actionable.
      invalidatePrScopes(qc, wsId, graphId)
      // main@head moved — re-read projection freshness so the "refreshing…" badge can show while
      // the FalkorDB cache catches up, and force live graph reads to refetch.
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.projectionWatermark(wsId, graphId) })
      bumpMainEpoch()
      // Rollups changed with main. Refetch now, and once more after the post-commit
      // projection nudge has had time to land (an immediate fetch can hit the stale
      // window and cache an empty result for the TTL).
      invalidateAggregatedEdges()
      setTimeout(invalidateAggregatedEdges, 4000)
    },
  })
}

/** Main advanced by a rollback commit — the same cache fan-out as a publish. */
function invalidateAfterMainAdvance(
  qc: ReturnType<typeof useQueryClient>,
  wsId: string,
  graphId: string,
  bumpMainEpoch: () => void,
) {
  qc.invalidateQueries({ queryKey: VERSIONING_KEYS.branches(wsId, graphId) })
  qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'commits'] })
  qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'viewCommits'] })
  qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'restorePreview'] })
  qc.invalidateQueries({ queryKey: VERSIONING_KEYS.resolve(wsId) })
  qc.invalidateQueries({ queryKey: VERSIONING_KEYS.projectionWatermark(wsId, graphId) })
  bumpMainEpoch()
  invalidateAggregatedEdges()
  setTimeout(invalidateAggregatedEdges, 4000)
}

/** Undo ONE published commit (new `revert` revision; keeps later work).
 *  Surfaces `MergeConflictError` when later commits touched the same entities. */
export function useRevertCommit(wsId: string, graphId: string) {
  const qc = useQueryClient()
  const bumpMainEpoch = useBranchStore((s) => s.bumpMainEpoch)
  return useMutation({
    mutationFn: (v: { commitId: string; message?: string }) =>
      api.revertCommit(wsId, graphId, v.commitId, v.message),
    onSuccess: () => invalidateAfterMainAdvance(qc, wsId, graphId, bumpMainEpoch),
  })
}

/** Reset main to its state at a commit (new `restore` revision; rolls back everything after). */
export function useRestoreCommit(wsId: string, graphId: string) {
  const qc = useQueryClient()
  const bumpMainEpoch = useBranchStore((s) => s.bumpMainEpoch)
  return useMutation({
    mutationFn: (v: { commitId: string; message?: string }) =>
      api.restoreCommit(wsId, graphId, v.commitId, v.message),
    onSuccess: () => invalidateAfterMainAdvance(qc, wsId, graphId, bumpMainEpoch),
  })
}

/** Exact impact of restoring to a commit — fetched while the confirm dialog is open. */
export function useRestorePreview(
  wsId?: string, graphId?: string | null, commitId?: string | null, enabled = true,
) {
  return useQuery({
    queryKey: VERSIONING_KEYS.restorePreview(wsId, graphId, commitId),
    queryFn: () => api.getRestorePreview(wsId!, graphId!, commitId!),
    enabled: enabled && !!wsId && !!graphId && !!commitId,
    staleTime: 15_000,
  })
}

/** Rebuild the fast read layer from the source of truth. Re-reads projection freshness on success so
 *  the (auto-polling) watermark drives the inline "Rebuilding… → Up to date" progress. */
export function useRebuildProjection(wsId: string, graphId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.rebuildProjection(wsId, graphId),
    onSuccess: (res) => {
      // Seed the watermark cache with the response's watermark BEFORE invalidating: on an instant
      // rebuild the refetch can come back already-fresh, so without this the progress effect never
      // observes the 'rebuilding' state and hangs at "Rebuilding…". Seeding guarantees one
      // 'rebuilding' observation; the (auto-polling) refetch then drives it to "Up to date".
      qc.setQueryData(VERSIONING_KEYS.projectionWatermark(wsId, graphId), res.watermark)
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.projectionWatermark(wsId, graphId) })
    },
  })
}

/** Check the fast read layer against the source of truth (user-triggered). Returns the DriftReport;
 *  a 409 (a check already running) surfaces as a plain error for the caller to toast. */
export function useReconcileProjection(wsId: string, graphId: string) {
  return useMutation({
    mutationFn: (v: { deep?: boolean } = {}) => api.reconcileProjection(wsId, graphId, v),
  })
}

export function useOpenMergeRequest(wsId: string, graphId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { branchId: string; title?: string; description?: string; reviewers?: string[] }) =>
      api.openMergeRequest(wsId, graphId, v.branchId, { title: v.title, description: v.description, reviewers: v.reviewers }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.mergeRequests(wsId, graphId) })
      qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'viewPrs'] })
      qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'dataSourcePrs'] })
      qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'viewPrCounts'] })
    },
  })
}

// PR review actions — keyed by prId; pass graphId so the right list refreshes (the inbox
// aggregates PRs from many graphs). All refresh the PR detail + its graph's MR list.
function useInvalidatePr(wsId: string) {
  const qc = useQueryClient()
  return (prId: string, graphId: string) => {
    qc.invalidateQueries({ queryKey: VERSIONING_KEYS.mergeRequest(wsId, prId) })
    invalidatePrScopes(qc, wsId, graphId)
  }
}

export function useApproveMergeRequest(wsId: string) {
  const invalidate = useInvalidatePr(wsId)
  return useMutation({
    mutationFn: (v: { prId: string; graphId: string }) => api.approveMergeRequest(wsId, v.prId),
    onSuccess: (_r, v) => invalidate(v.prId, v.graphId),
  })
}

export function useCloseMergeRequest(wsId: string) {
  const invalidate = useInvalidatePr(wsId)
  return useMutation({
    mutationFn: (v: { prId: string; graphId: string }) => api.closeMergeRequest(wsId, v.prId),
    onSuccess: (_r, v) => invalidate(v.prId, v.graphId),
  })
}

/** Edit a PR's title/description in place. */
export function useUpdateMergeRequest(wsId: string) {
  const invalidate = useInvalidatePr(wsId)
  return useMutation({
    mutationFn: (v: { prId: string; graphId: string; title?: string; description?: string }) =>
      api.updateMergeRequest(wsId, v.prId, { title: v.title, description: v.description }),
    onSuccess: (_r, v) => invalidate(v.prId, v.graphId),
  })
}

/** Merge a PR. Throws {@link api.MergeConflictError} on conflicts (caller resolves +
 *  re-merges with `resolutions`) and a plain error on `approval_required`. */
export function useMergeMergeRequest(wsId: string) {
  const qc = useQueryClient()
  const invalidate = useInvalidatePr(wsId)
  const bumpMainEpoch = useBranchStore((s) => s.bumpMainEpoch)
  return useMutation({
    mutationFn: (v: { prId: string; graphId: string; message: string; resolutions?: ResolutionMap }) =>
      api.mergeMergeRequest(wsId, v.prId, { message: v.message, resolutions: v.resolutions }),
    onSuccess: (_r, v) => {
      invalidate(v.prId, v.graphId)
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.prDiff(wsId, v.prId) })
      // Refresh ALL commit-log scopes by prefix — the merged squash commit must show in History's
      // "This view" / "Whole graph" (viewCommits) and per-branch (commits) lists without a reload.
      qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'commits'] })
      qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'viewCommits'] })
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.branches(wsId, v.graphId) })
      // `resolve` carries mainHeadCommitSeq — the number EVERY other draft's "behind" check is
      // measured against. It has a 5-minute staleTime, so omitting it here meant that after a merge
      // no other draft showed as behind for up to five minutes: they looked mergeable and then 409'd.
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.resolve(wsId) })
      // main@head moved — re-read projection freshness so the "refreshing…" badge can show if lagging.
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.projectionWatermark(wsId, v.graphId) })
      bumpMainEpoch()   // main@head moved
      // Rollups changed with main (see usePublishBranch): refetch now + after the projection nudge.
      invalidateAggregatedEdges()
      setTimeout(invalidateAggregatedEdges, 4000)
    },
  })
}
