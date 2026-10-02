/**
 * What a share link is allowed to know about a graph's properties.
 *
 * `/search/discover` samples every label in the data source and answers
 * with the keys, tags and value samples behind the builder's
 * autocomplete. A capability identity — someone holding a link to ONE
 * view, with no workspace membership — is refused it: the answer spans
 * the whole source, not the view they were given.
 *
 * That refusal is not a failure. It arrives on every open, it will never
 * succeed, and there is nothing the viewer can do about it — so a red
 * "Discovery failed" banner is the wrong shape for it entirely. The hook
 * tells the difference: a 403 is `unavailable`, and only a real fault
 * (5xx, network, timeout) is an `error`.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'

const provider = new RemoteGraphProvider({ workspaceId: 'ws-1', viewId: 'view-1' })

vi.mock('@/providers/GraphProviderContext', () => ({
    useGraphProvider: () => provider,
}))

import { useDiscovery } from '../useDiscovery'


/** What the provider throws for an HTTP failure. */
function apiError(status: number, body: string): Error {
    return Object.assign(new Error(`API Error ${status}: ${body}`), { status })
}

function discover() {
    return renderHook(() => useDiscovery('view-1'))
}


beforeEach(() => {
    vi.restoreAllMocks()
})


describe('useDiscovery — refused vs broken', () => {
    it('reports a 403 as unavailable, with nothing to report as an error', async () => {
        vi.spyOn(provider, 'discoverSearchableProperties').mockRejectedValue(
            apiError(403, '{"detail":"Property discovery is not available for this shared view"}'),
        )
        const { result } = discover()

        await waitFor(() => expect(result.current.isInitialLoading).toBe(false))
        expect(result.current.unavailable).toBe(true)
        expect(result.current.error).toBeNull()
        // Look-in and the editors fall back to free text; nothing is offered.
        expect(result.current.allKeys).toEqual([])
        expect(result.current.tagValues).toEqual([])
    })

    it('still reports a 500 as the failure it is', async () => {
        vi.spyOn(provider, 'discoverSearchableProperties').mockRejectedValue(
            apiError(500, 'boom'),
        )
        const { result } = discover()

        await waitFor(() => expect(result.current.isInitialLoading).toBe(false))
        expect(result.current.unavailable).toBe(false)
        expect(result.current.error?.message).toContain('500')
    })

    it('treats an error carrying no status as a failure, not a refusal', async () => {
        // A timeout or a network drop — `fetchWithTimeout` throws its own.
        vi.spyOn(provider, 'discoverSearchableProperties').mockRejectedValue(
            new Error('Request timed out: GET /search/discover'),
        )
        const { result } = discover()

        await waitFor(() => expect(result.current.isInitialLoading).toBe(false))
        expect(result.current.unavailable).toBe(false)
        expect(result.current.error?.message).toContain('timed out')
    })

    it('clears a previous refusal once discovery answers', async () => {
        const spy = vi.spyOn(provider, 'discoverSearchableProperties')
            .mockRejectedValue(apiError(403, 'nope'))
        const { result, rerender } = renderHook(
            ({ viewId }) => useDiscovery(viewId),
            { initialProps: { viewId: 'view-1' } },
        )
        await waitFor(() => expect(result.current.unavailable).toBe(true))

        spy.mockResolvedValue({ labels: { dataset: { keys: ['owner'] } } } as never)
        rerender({ viewId: 'view-2' })

        await waitFor(() => expect(result.current.allKeys).toEqual(['owner']))
        expect(result.current.unavailable).toBe(false)
    })
})
