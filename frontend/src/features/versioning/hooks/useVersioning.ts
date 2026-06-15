/**
 * React Query hooks for the versioning surface — queries + lifecycle mutations,
 * with the invalidation fan-out that keeps the BranchSwitcher, diff overlay, and
 * history in sync after a save / publish / merge.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '@/services/versioningApiService'
import type { ResolutionMap, StageOp } from '@/services/versioningApiService'
import { useBranchStore } from '@/store/branchStore'

export const VERSIONING_KEYS = {
  all: ['versioning'] as const,
  resolve: (ws?: string, ds?: string | null) => [...VERSIONING_KEYS.all, 'resolve', ws, ds] as const,
  branches: (ws?: string, gid?: string | null) => [...VERSIONING_KEYS.all, 'branches', ws, gid] as const,
  branchState: (ws?: string, gid?: string | null, bid?: string | null) =>
    [...VERSIONING_KEYS.all, 'state', ws, gid, bid] as const,
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
  projectionWatermark: (ws?: string, gid?: string | null) =>
    [...VERSIONING_KEYS.all, 'watermark', ws, gid] as const,
}

// ── Queries ────────────────────────────────────────────────────────────────

/** Resolve a data source → its graph + the caller's open draft. The switcher's spine. */
export function useResolveGraph(wsId?: string, dataSourceId?: string | null) {
  return useQuery({
    queryKey: VERSIONING_KEYS.resolve(wsId, dataSourceId),
    queryFn: () => api.resolveGraph(wsId!, dataSourceId!),
    enabled: !!wsId && !!dataSourceId,
    staleTime: 30_000,
    // A 404 means this data source has no versioned graph — don't hammer it.
    retry: (n, e) => !/404|not found/i.test(String((e as Error)?.message)) && n < 2,
  })
}

export function useBranches(wsId?: string, graphId?: string | null) {
  return useQuery({
    queryKey: VERSIONING_KEYS.branches(wsId, graphId),
    queryFn: () => api.listBranches(wsId!, graphId!),
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
 *  forever. A merge/publish invalidates this query, so a freshly-started projection is picked up. */
export function useProjectionWatermark(wsId?: string, graphId?: string | null) {
  return useQuery({
    queryKey: VERSIONING_KEYS.projectionWatermark(wsId, graphId),
    queryFn: () => api.getWatermark(wsId!, graphId!),
    enabled: !!wsId && !!graphId,
    refetchInterval: (q) => {
      const d = q.state.data
      const active = d?.status === 'projecting' || d?.status === 'rebuilding'
      return d && d.fresh === false && active ? 3_000 : false
    },
    staleTime: 2_000,
    refetchOnWindowFocus: false,
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

/** One PR's detail (works for draft MRs and fork PRs — the endpoint dispatches). */
export function useMergeRequest(wsId?: string, prId?: string | null) {
  return useQuery({
    queryKey: VERSIONING_KEYS.mergeRequest(wsId, prId),
    queryFn: () => api.getMergeRequest(wsId!, prId!),
    enabled: !!wsId && !!prId,
    staleTime: 10_000,
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

/** A view's change history — view-scoped (across branches) or graph-wide (`main`). */
export function useViewCommitLog(
  wsId?: string, graphId?: string | null,
  opts: { viewId?: string | null; graphWide?: boolean; limit?: number } = {},
) {
  const { viewId, graphWide, limit } = opts
  return useQuery({
    queryKey: VERSIONING_KEYS.viewCommitLog(wsId, graphId, viewId, graphWide, limit),
    queryFn: () =>
      api.getCommitLog(wsId!, graphId!, graphWide || !viewId ? { limit } : { originatingViewId: viewId, limit }),
    enabled: !!wsId && !!graphId && (graphWide || !!viewId),
    staleTime: 15_000,
  })
}

// ── Mutations ────────────────────────────────────────────────────────────────

/** Enable version control for a data source (create-or-seed its versioned graph). */
export function useBootstrapGraph(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dataSourceId: string) => api.bootstrapGraph(wsId, dataSourceId),
    onSuccess: (_res, dataSourceId) => {
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.resolve(wsId, dataSourceId) })
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

export function usePublishBranch(wsId: string, graphId: string) {
  const qc = useQueryClient()
  const bumpMainEpoch = useBranchStore((s) => s.bumpMainEpoch)
  return useMutation({
    mutationFn: (v: { branchId: string; message: string; resolutions?: ResolutionMap }) =>
      api.publishBranch(wsId, graphId, v.branchId, { message: v.message, resolutions: v.resolutions }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.branches(wsId, graphId) })
      // Refresh ALL commit-log scopes by prefix — the new squash commit must show in History's
      // "This view" / "Whole graph" (viewCommits) and per-branch (commits) lists without a reload.
      qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'commits'] })
      qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'viewCommits'] })
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.resolve(wsId) })
      // main@head moved — re-read projection freshness so the "refreshing…" badge can show while
      // the FalkorDB cache catches up, and force live graph reads to refetch.
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.projectionWatermark(wsId, graphId) })
      bumpMainEpoch()
    },
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
    qc.invalidateQueries({ queryKey: VERSIONING_KEYS.mergeRequests(wsId, graphId) })
    qc.invalidateQueries({ queryKey: VERSIONING_KEYS.mergeRequest(wsId, prId) })
    // The view/data-source lists + indicator counts are keyed by view/ds (unknown here),
    // so refresh them by prefix — a status change moves a PR in/out of the active set.
    qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'viewPrs'] })
    qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'dataSourcePrs'] })
    qc.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, 'viewPrCounts'] })
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
      // main@head moved — re-read projection freshness so the "refreshing…" badge can show if lagging.
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.projectionWatermark(wsId, v.graphId) })
      bumpMainEpoch()   // main@head moved
    },
  })
}
