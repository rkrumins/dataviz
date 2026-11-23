/**
 * A data source's details and trust, and its history — read while the switch is on. A save
 * replaces what the drawer holds and refreshes the workspace (its cards and filter read the
 * same fields). When someone else saved first, the newer version takes the cache's place
 * and the caller keeps its draft: `isStale` says so.
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useFeature } from '@/store/features'
import {
    DATA_SOURCE_METADATA_FEATURE, dataSourceMetadataService,
    type DataSourceMetadata, type DetailsBody, type TrustBody,
} from '@/services/dataSourceMetadataService'

export const metadataKey = (wsId: string, dsId: string) => ['data-source-metadata', wsId, dsId] as const
export const sourceActivityKey = (wsId: string, dsId: string) => ['data-source-activity', wsId, dsId] as const

type Refusal = { detail?: { type?: string; message?: string; current?: DataSourceMetadata } }

/** Someone else saved first: the server says so with 409 `stale`. */
export function isStale(e: unknown): boolean {
    return (e as Refusal | null)?.detail?.type === 'stale'
}

/** What to tell the person about a refusal, in the server's words where it gave some. */
export function refusalMessage(e: unknown, fallback: string): string {
    const r = e as Refusal | null
    return r?.detail?.message || (e instanceof Error && e.message) || fallback
}

export function useDataSourceMetadata(wsId: string, dsId: string) {
    const on = useFeature(DATA_SOURCE_METADATA_FEATURE)
    return useQuery({
        queryKey: metadataKey(wsId, dsId),
        queryFn: () => dataSourceMetadataService.get(wsId, dsId),
        enabled: on,
        staleTime: 60_000,
    })
}

export function useSaveDataSourceMetadata(wsId: string, dsId: string) {
    const queryClient = useQueryClient()
    const current = () => queryClient.getQueryData<DataSourceMetadata>(metadataKey(wsId, dsId))
    const onSuccess = (fresh: DataSourceMetadata) => {
        queryClient.setQueryData(metadataKey(wsId, dsId), fresh)
        void queryClient.invalidateQueries({ queryKey: ['workspace', wsId] })
        void queryClient.invalidateQueries({ queryKey: sourceActivityKey(wsId, dsId) })
    }
    const onError = (e: unknown) => {
        if (!isStale(e)) return
        const newer = (e as Refusal).detail?.current
        if (newer) queryClient.setQueryData(metadataKey(wsId, dsId), newer)
        else void queryClient.invalidateQueries({ queryKey: metadataKey(wsId, dsId) })
    }
    return {
        saveDetails: useMutation({
            mutationFn: (body: DetailsBody) => dataSourceMetadataService.saveDetails(wsId, dsId, {
                ...body, expectedUpdatedAt: current()?.updatedAt ?? null,
            }),
            onSuccess, onError,
        }),
        saveTrust: useMutation({
            mutationFn: (body: TrustBody) => dataSourceMetadataService.saveTrust(wsId, dsId, {
                ...body, expectedUpdatedAt: current()?.updatedAt ?? null,
            }),
            onSuccess, onError,
        }),
    }
}

export function useDataSourceActivity(wsId: string, dsId: string) {
    const on = useFeature(DATA_SOURCE_METADATA_FEATURE)
    return useInfiniteQuery({
        queryKey: sourceActivityKey(wsId, dsId),
        queryFn: ({ pageParam }) => dataSourceMetadataService.listActivity(wsId, dsId, pageParam),
        initialPageParam: null as string | null,
        getNextPageParam: last => last.nextCursor ?? undefined,
        enabled: on,
        staleTime: 15_000,
    })
}
