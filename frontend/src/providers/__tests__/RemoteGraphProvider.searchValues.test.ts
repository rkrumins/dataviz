/**
 * `searchPropertyValues` — the value picker's counted suggestions. Pins the
 * request (a GET carrying the view, the key and the typed text) and that a
 * 19-digit value comes back as its exact digits, not a rounded double.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/fetchWithTimeout', () => ({
    fetchWithTimeout: vi.fn(),
}))

import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { RemoteGraphProvider } from '../RemoteGraphProvider'

const mockFetch = vi.mocked(fetchWithTimeout)

function okText(text: string): Response {
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => JSON.parse(text),
        text: async () => text,
    } as unknown as Response
}

afterEach(() => {
    vi.clearAllMocks()
})

describe('RemoteGraphProvider.searchPropertyValues', () => {
    it('asks for one property of one view, narrowed by the typed text', async () => {
        mockFetch.mockResolvedValue(okText(
            '{"key":"gvHash","values":[{"value":-3746471915534727923,"count":2}],'
            + '"complete":true,"truncated":false,"elapsedMs":4}',
        ))
        const provider = new RemoteGraphProvider({ workspaceId: 'ws_1', dataSourceId: 'ds_1' })

        const result = await provider.searchPropertyValues('view-1', 'gvHash', '74', 25)

        const url = new URL(String(mockFetch.mock.calls[0][0]), 'http://app.local')
        expect(url.pathname).toMatch(/\/search\/values$/)
        expect(url.searchParams.get('viewId')).toBe('view-1')
        expect(url.searchParams.get('key')).toBe('gvHash')
        expect(url.searchParams.get('q')).toBe('74')
        expect(url.searchParams.get('limit')).toBe('25')
        expect(result.values).toEqual([{ value: '-3746471915534727923', count: 2 }])
    })
})
