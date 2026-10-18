/**
 * The library's reads follow Admin → Features → Layout templates: off, they
 * stop asking the server and answer nothing — not even what was cached while
 * it was on, so search and a view's header fall quiet without a reload.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

const { service } = vi.hoisted(() => ({ service: { list: vi.fn(), get: vi.fn() } }))
vi.mock('@/services/layoutTemplateService', () => ({ layoutTemplateService: service }))

import { useLayoutTemplate, useLayoutTemplates } from '../useLayoutTemplates'

const TPL = { id: 'tpl_1', name: 'Finance flow' }

function renderReads() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    return renderHook(() => ({ list: useLayoutTemplates(), one: useLayoutTemplate('tpl_1') }), { wrapper })
}

const setTemplates = (on: boolean) =>
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, layoutTemplatesEnabled: on } })

afterEach(() => {
    cleanup()
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } })
    vi.clearAllMocks()
})

describe('the library follows the layout templates switch', () => {
    it('answers nothing once an admin turns templates off, even from the cache', async () => {
        service.list.mockResolvedValue({ items: [TPL], total: 1 })
        service.get.mockResolvedValue(TPL)
        const { result } = renderReads()
        await waitFor(() => expect(result.current.list.templates).toHaveLength(1))
        await waitFor(() => expect(result.current.one.data?.id).toBe('tpl_1'))

        act(() => setTemplates(false))

        expect(result.current.list.templates).toEqual([])
        expect(result.current.one.data).toBeUndefined()
        expect(service.list).toHaveBeenCalledTimes(1)
    })

    it('never asks the server while templates are off', () => {
        setTemplates(false)
        renderReads()
        expect(service.list).not.toHaveBeenCalled()
        expect(service.get).not.toHaveBeenCalled()
    })
})
