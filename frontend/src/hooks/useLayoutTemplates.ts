/**
 * The layout template library, cached once for every surface that offers it:
 * the Templates page, the view wizard's Layout step, the Dashboard and search.
 *
 * The server returns the caller's whole readable set (it is small — layouts,
 * not data), so tabs, search, categories and sorting all run client-side.
 */
import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAppNotifications } from '@/components/ui/notifications'
import {
    layoutTemplateService,
    type LayoutTemplate,
} from '@/services/layoutTemplateService'

export const LAYOUT_TEMPLATES_KEY = ['layout-templates'] as const

const EMPTY: LayoutTemplate[] = []

export function useLayoutTemplates(opts: { includeHidden?: boolean; enabled?: boolean } = {}) {
    const includeHidden = !!opts.includeHidden
    const query = useQuery({
        queryKey: [...LAYOUT_TEMPLATES_KEY, 'list', { includeHidden }],
        queryFn: () => layoutTemplateService.list({ includeHidden }),
        enabled: opts.enabled ?? true,
        staleTime: 60_000,
    })
    return {
        templates: query.data?.items ?? EMPTY,
        isLoading: query.isLoading,
        error: query.error as Error | null,
        refetch: query.refetch,
    }
}

export function useLayoutTemplate(id: string | null | undefined) {
    return useQuery({
        queryKey: [...LAYOUT_TEMPLATES_KEY, 'one', id ?? ''],
        queryFn: () => layoutTemplateService.get(id!),
        enabled: !!id,
        retry: false,
    })
}

/** Every cached copy of the library is stale after a change. */
export function useInvalidateLayoutTemplates() {
    const queryClient = useQueryClient()
    return useCallback(
        () => queryClient.invalidateQueries({ queryKey: LAYOUT_TEMPLATES_KEY }),
        [queryClient],
    )
}

/**
 * Delete now, with an Undo that puts back the same template — its shares and
 * the views that name it included. The card leaves the library at once.
 */
export function useDeleteLayoutTemplate() {
    const queryClient = useQueryClient()
    const invalidate = useInvalidateLayoutTemplates()
    const { notify } = useAppNotifications()

    return useCallback(async (template: LayoutTemplate) => {
        queryClient.setQueriesData<{ items: LayoutTemplate[]; total: number }>(
            { queryKey: [...LAYOUT_TEMPLATES_KEY, 'list'] },
            (old) => old && {
                items: old.items.filter(t => t.id !== template.id),
                total: Math.max(0, old.total - 1),
            },
        )
        try {
            await layoutTemplateService.remove(template.id)
        } catch (err) {
            void invalidate()
            notify('error', `Couldn't delete "${template.name}": ${(err as Error).message}`)
            return
        }
        void invalidate()
        notify('success', `Deleted "${template.name}"`, {
            label: 'Undo',
            onClick: () => {
                layoutTemplateService.restore(template.id)
                    .then(() => notify('success', `Restored "${template.name}"`))
                    .catch((err: Error) => notify('error', `Couldn't restore "${template.name}": ${err.message}`))
                    .finally(() => void invalidate())
            },
        }, 10_000)
    }, [queryClient, invalidate, notify])
}

/** Hide a built-in for everyone but template managers, or show it again. */
export function useSetLayoutTemplateHidden() {
    const invalidate = useInvalidateLayoutTemplates()
    const { notify } = useAppNotifications()

    return useCallback(async (template: LayoutTemplate, hidden: boolean) => {
        try {
            await layoutTemplateService.setHidden(template.id, hidden)
            notify('success', hidden
                ? `"${template.name}" is hidden. Only template managers see it now.`
                : `"${template.name}" is back in everyone's library.`,
            hidden ? { label: 'Undo', onClick: () => {
                layoutTemplateService.setHidden(template.id, false).finally(() => void invalidate())
            } } : undefined)
        } catch (err) {
            notify('error', (err as Error).message)
        } finally {
            void invalidate()
        }
    }, [invalidate, notify])
}
