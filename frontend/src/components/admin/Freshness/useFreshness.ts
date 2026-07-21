/**
 * useFreshness — React Query hooks for the Ingestion → Freshness cockpit.
 *
 * The fleet query polls every 30s WHILE MOUNTED (React Query stops the
 * interval on unmount, so switching tabs kills the poll — no background
 * leak). Refresh mutations invalidate the fleet key so the table reflects
 * the new state without a manual reload. The batch progress query polls
 * every 2s and stops itself once the batch reports ``state: "done"``.
 */
import {
    keepPreviousData,
    useMutation,
    useQuery,
    useQueryClient,
    type UseMutationResult,
    type UseQueryResult,
} from '@tanstack/react-query'
import {
    freshnessService,
    type BatchStatus,
    type FleetParams,
    type FreshnessDoc,
    type FreshnessFleetResponse,
    type FreshnessSettings,
    type RefreshResponse,
    type RefreshScope,
} from '@/services/freshnessService'
import { ACTIVE_JOBS_KEY } from './useActiveJobs'

/** One generous page — the cockpit is a bounded operator surface, so a
 *  single fetch covers the common fleet size without pagination controls. */
const FLEET_PAGE_SIZE = 200
const FLEET_POLL_MS = 30_000
const BATCH_POLL_MS = 2_000

export const FRESHNESS_KEYS = {
    all: ['freshness'] as const,
    fleetPrefix: ['freshness', 'fleet'] as const,
    fleet: (params: FleetParams) =>
        [
            'freshness',
            'fleet',
            params.workspaceId ?? null,
            params.providerId ?? null,
            !!params.staleOnly,
        ] as const,
    doc: (dsId: string, probe: boolean) => ['freshness', 'doc', dsId, probe] as const,
    batch: (batchId: string) => ['freshness', 'batch', batchId] as const,
}

export function useFleetFreshness(
    params: FleetParams = {},
    enabled = true,
): UseQueryResult<FreshnessFleetResponse, Error> {
    return useQuery<FreshnessFleetResponse, Error>({
        queryKey: FRESHNESS_KEYS.fleet(params),
        queryFn: () => freshnessService.listFleet({ ...params, pageSize: FLEET_PAGE_SIZE }),
        enabled,
        staleTime: 15_000,
        refetchInterval: FLEET_POLL_MS,
        retry: 1,
    })
}

export function useSourceFreshness(
    dsId: string | null,
    probe: boolean,
    enabled = true,
): UseQueryResult<FreshnessDoc, Error> {
    return useQuery<FreshnessDoc, Error>({
        queryKey: FRESHNESS_KEYS.doc(dsId ?? '', probe),
        queryFn: () => freshnessService.getSourceDoc(dsId!, probe),
        enabled: enabled && !!dsId,
        staleTime: 15_000,
        // Toggling "Probe now" changes the key; keep the prior doc on screen
        // (dimmed via isFetching) instead of flashing back to a spinner.
        placeholderData: keepPreviousData,
        retry: 1,
    })
}

export interface RefreshSourceVars {
    dsId: string
    scope: RefreshScope
    force?: boolean
}

export function useRefreshSource(): UseMutationResult<RefreshResponse, Error, RefreshSourceVars> {
    const qc = useQueryClient()
    return useMutation<RefreshResponse, Error, RefreshSourceVars>({
        mutationFn: ({ dsId, scope, force }) =>
            freshnessService.refreshSource(dsId, { scope, force }),
        onSuccess: (_res, { dsId }) => {
            void qc.invalidateQueries({ queryKey: FRESHNESS_KEYS.fleetPrefix })
            // The drawer's resolution guidance reads this source's doc — refetch
            // it so a Clear-cache/Retry from the drawer reflects immediately.
            void qc.invalidateQueries({ queryKey: ['freshness', 'doc', dsId] })
            // A rollups/full scope can start a job; keep the joined-job feed
            // from lagging the fleet feed (shortens the divergence window
            // behind the row's own state === 'recomputing' gate).
            void qc.invalidateQueries({ queryKey: ACTIVE_JOBS_KEY })
        },
    })
}

export interface SetFreshnessSettingsVars {
    dsId: string
    rebuildMinIntervalSecs: number | null
}

/** Set/clear a source's rebuild-cadence override; invalidates that source's
 *  doc and the fleet so the badge + drawer reflect the new window. */
export function useSetFreshnessSettings(): UseMutationResult<FreshnessSettings, Error, SetFreshnessSettingsVars> {
    const qc = useQueryClient()
    return useMutation<FreshnessSettings, Error, SetFreshnessSettingsVars>({
        mutationFn: ({ dsId, rebuildMinIntervalSecs }) =>
            freshnessService.patchFreshnessSettings(dsId, { rebuildMinIntervalSecs }),
        onSuccess: (_res, { dsId }) => {
            void qc.invalidateQueries({ queryKey: ['freshness', 'doc', dsId] })
            void qc.invalidateQueries({ queryKey: FRESHNESS_KEYS.fleetPrefix })
        },
    })
}

export interface RefreshProviderVars {
    providerId: string
    scope: RefreshScope
    force?: boolean
}

export function useRefreshProvider(): UseMutationResult<BatchStatus, Error, RefreshProviderVars> {
    return useMutation<BatchStatus, Error, RefreshProviderVars>({
        mutationFn: ({ providerId, scope, force }) =>
            freshnessService.refreshProvider(providerId, { scope, force }),
    })
}

export interface RefreshFleetVars {
    scope: RefreshScope
    force?: boolean
}

/** Kick off the fleet-wide guarded batch. Progress is polled with the shared
 *  ``useRefreshBatch`` (same BatchStatus shape as the provider batch), so this
 *  only starts it; the caller invalidates the fleet on ``done``. */
export function useRefreshFleet(): UseMutationResult<BatchStatus, Error, RefreshFleetVars> {
    return useMutation<BatchStatus, Error, RefreshFleetVars>({
        mutationFn: ({ scope, force }) => freshnessService.refreshAll({ scope, force }),
    })
}

/** Poll a running batch every 2s; stop as soon as it reports ``done``. */
export function useRefreshBatch(
    batchId: string | null,
    enabled = true,
): UseQueryResult<BatchStatus, Error> {
    return useQuery<BatchStatus, Error>({
        queryKey: FRESHNESS_KEYS.batch(batchId ?? ''),
        queryFn: () => freshnessService.getBatch(batchId!),
        enabled: enabled && !!batchId,
        // Stop once the batch is done, or after 5 terminal errors with no
        // success since (a dead runner shouldn't poll forever — the dialog's
        // Close stays enabled so the user can still dismiss it).
        refetchInterval: (q) =>
            q.state.data?.state === 'done' ||
            (q.state.errorUpdateCount >= 5 && q.state.errorUpdatedAt > q.state.dataUpdatedAt)
                ? false : BATCH_POLL_MS,
        refetchIntervalInBackground: false,
        retry: 1,
    })
}
