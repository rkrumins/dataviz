/**
 * The layout template library, cached once for every surface that offers it:
 * the Templates page, the view wizard's Layout step, the Dashboard and search.
 *
 * The server returns the caller's whole readable set (it is small — layouts,
 * not data), so tabs, search, categories and sorting all run client-side.
 *
 * Admin → Features → Layout templates switches all of it off for everyone: the
 * reads below stop asking, and answer nothing even from what was cached before
 * the switch went off, so every surface built on them falls quiet.
 */
import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAppNotifications } from '@/components/ui/notifications'
import { useFeature } from '@/store/features'
import {
    layoutTemplateService,
    type LayoutTemplate,
} from '@/services/layoutTemplateService'

export const LAYOUT_TEMPLATES_KEY = ['layout-templates'] as const

/** Admin → Features → Layout templates. */
export const LAYOUT_TEMPLATES_FEATURE = 'layoutTemplatesEnabled'

export function useLayoutTemplatesEnabled(): boolean {
    return useFeature(LAYOUT_TEMPLATES_FEATURE)
}

const EMPTY: LayoutTemplate[] = []

export function useLayoutTemplates(opts: { includeHidden?: boolean; enabled?: boolean } = {}) {
    const includeHidden = !!opts.includeHidden
    const on = useLayoutTemplatesEnabled()
    const query = useQuery({
        queryKey: [...LAYOUT_TEMPLATES_KEY, 'list', { includeHidden }],
        queryFn: () => layoutTemplateService.list({ includeHidden }),
        enabled: (opts.enabled ?? true) && on,
        staleTime: 60_000,
    })
    return {
        templates: on ? query.data?.items ?? EMPTY : EMPTY,
        isLoading: query.isLoading,
        error: query.error as Error | null,
        refetch: query.refetch,
    }
}

export function useLayoutTemplate(id: string | null | undefined) {
    const on = useLayoutTemplatesEnabled()
    return useQuery({
        queryKey: [...LAYOUT_TEMPLATES_KEY, 'one', on ? id ?? '' : ''],
        queryFn: () => layoutTemplateService.get(id!),
        enabled: !!id && on,
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

/**
 * A favourite, at once: every cached list shows the heart before the server
 * answers, and puts it back if the server refuses.
 */
export function useToggleTemplateFavourite() {
    const queryClient = useQueryClient()
    const { notify } = useAppNotifications()

    return useCallback(async (template: LayoutTemplate) => {
        const next = !template.isFavourite
        const patch = (on: boolean) => {
            const apply = (t: LayoutTemplate) => (t.id === template.id ? { ...t, isFavourite: on } : t)
            queryClient.setQueriesData<{ items: LayoutTemplate[]; total: number }>(
                { queryKey: [...LAYOUT_TEMPLATES_KEY, 'list'] },
                old => old && { ...old, items: old.items.map(apply) },
            )
            queryClient.setQueryData<LayoutTemplate>([...LAYOUT_TEMPLATES_KEY, 'one', template.id], old => old && apply(old))
        }
        patch(next)
        try {
            if (next) await layoutTemplateService.favourite(template.id)
            else await layoutTemplateService.unfavourite(template.id)
        } catch (err) {
            patch(!next)
            notify('error', (err as Error).message)
        }
    }, [queryClient, notify])
}

/** Requests to offer a team's template to everyone — for the template managers who answer them. */
export function usePromotionRequests(enabled: boolean) {
    const on = useLayoutTemplatesEnabled()
    return useQuery({
        queryKey: [...LAYOUT_TEMPLATES_KEY, 'promotion-requests'],
        queryFn: () => layoutTemplateService.promotionRequests(),
        enabled: enabled && on,
        staleTime: 30_000,
    })
}
