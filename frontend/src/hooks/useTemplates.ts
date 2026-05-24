/**
 * React Query hooks for ContextViewCanvas templates.
 *
 * The Templates management page binds these to UI controls;
 * filters/sort/search live in URL search params so the gallery
 * state is deep-linkable and survives page refresh.
 */
import { useQuery, useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import type {
    ContextModel,
    ContextModelCreateRequest,
    ContextModelUpdateRequest,
    TemplateListFilter,
    TemplateUsageStats,
} from '@/services/contextModelService'
import {
    listAllTemplates,
    getTemplate,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    duplicateTemplate,
    importTemplate,
    getTemplateUsage,
} from '@/services/contextModelService'

const STALE_MS = 30_000

export const templateKeys = {
    all: ['templates'] as const,
    list: (filter: TemplateListFilter) => ['templates', 'list', filter] as const,
    detail: (id: string) => ['templates', 'detail', id] as const,
    usage: (id: string) => ['templates', 'usage', id] as const,
}

export function useTemplatesList(
    filter: TemplateListFilter,
): UseQueryResult<ContextModel[]> {
    return useQuery({
        queryKey: templateKeys.list(filter),
        queryFn: () => listAllTemplates(filter),
        staleTime: STALE_MS,
    })
}

export function useTemplate(id: string | null | undefined): UseQueryResult<ContextModel> {
    return useQuery({
        queryKey: id ? templateKeys.detail(id) : ['templates', 'detail', 'noop'],
        queryFn: () => getTemplate(id as string),
        enabled: !!id,
        staleTime: STALE_MS,
    })
}

export function useTemplateUsage(
    id: string | null | undefined,
): UseQueryResult<TemplateUsageStats> {
    return useQuery({
        queryKey: id ? templateKeys.usage(id) : ['templates', 'usage', 'noop'],
        queryFn: () => getTemplateUsage(id as string),
        enabled: !!id,
        staleTime: STALE_MS,
    })
}

export function useCreateTemplate() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: (data: ContextModelCreateRequest) => createTemplate(data),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: templateKeys.all })
        },
    })
}

export function useUpdateTemplate() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: ({ id, data }: { id: string; data: ContextModelUpdateRequest }) =>
            updateTemplate(id, data),
        onSuccess: (updated) => {
            qc.setQueryData(templateKeys.detail(updated.id), updated)
            qc.invalidateQueries({ queryKey: templateKeys.all })
        },
    })
}

export function useDeleteTemplate() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: ({ id, permanent }: { id: string; permanent?: boolean }) =>
            deleteTemplate(id, { permanent }),
        onSuccess: (_, { id }) => {
            qc.removeQueries({ queryKey: templateKeys.detail(id) })
            qc.invalidateQueries({ queryKey: templateKeys.all })
        },
    })
}

export function useDuplicateTemplate() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: ({ id, name, workspaceId }: {
            id: string; name: string; workspaceId?: string | null
        }) => duplicateTemplate(id, name, workspaceId),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: templateKeys.all })
        },
    })
}

export function useImportTemplate() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: (payload: ContextModelCreateRequest) => importTemplate(payload),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: templateKeys.all })
        },
    })
}
