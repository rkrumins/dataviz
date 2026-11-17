/**
 * A draft's review decided change by change, through react-query: its change list with each
 * change's decision, a page at a time; where its decisions stand; and deciding. Every decision
 * refreshes them all (what a change takes with it is decided with it, so many rows can move).
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  decideReviewChanges, getReviewDecisionSummary, listReviewChanges, type DecisionFilter,
} from '@/services/versioningApiService'

const PAGE = 200

export const DECISION_KEYS = {
  all: (wsId: string, prId: string) => ['reviewDecisions', wsId, prId] as const,
  summary: (wsId: string, prId: string) => ['reviewDecisions', wsId, prId, 'summary'] as const,
  changes: (wsId: string, prId: string, f: DecisionFilter, summary = false) => ['reviewDecisions', wsId, prId, 'changes',
    f.decision ?? 'all', f.kind ?? 'all', (f.statuses ?? []).join(','), f.type ?? '', (f.q ?? '').trim(),
    summary ? 'summary' : 'plain'] as const,
}

export function useReviewChanges(wsId: string, prId: string | null | undefined, filter: DecisionFilter, enabled: boolean,
  summary = false) {
  return useInfiniteQuery({
    queryKey: DECISION_KEYS.changes(wsId, prId ?? '', filter, summary),
    queryFn: ({ pageParam }) => listReviewChanges(wsId, prId!, filter, pageParam, PAGE, summary),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.hasMore ? last.offset + last.entries.length : undefined),
    enabled: enabled && !!prId,
  })
}

export function useReviewDecisionSummary(wsId: string, prId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: DECISION_KEYS.summary(wsId, prId ?? ''),
    queryFn: () => getReviewDecisionSummary(wsId, prId!),
    enabled: enabled && !!prId,
    refetchOnWindowFocus: true,
  })
}

export function useDecideChanges(wsId: string, prId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Parameters<typeof decideReviewChanges>[2]) => decideReviewChanges(wsId, prId, body),
    onSuccess: (out) => {
      if (!out.dryRun) void qc.invalidateQueries({ queryKey: DECISION_KEYS.all(wsId, prId) })
    },
  })
}
