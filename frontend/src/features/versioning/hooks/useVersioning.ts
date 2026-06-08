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
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.commitLog(wsId, graphId) })
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.resolve(wsId) })
      // main@head moved — force live graph reads to refetch.
      bumpMainEpoch()
    },
  })
}

export function useOpenMergeRequest(wsId: string, graphId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { branchId: string; title?: string; reviewers?: string[] }) =>
      api.openMergeRequest(wsId, graphId, v.branchId, { title: v.title, reviewers: v.reviewers }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: VERSIONING_KEYS.mergeRequests(wsId, graphId) })
    },
  })
}
