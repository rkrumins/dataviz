import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi } from 'vitest'

const listTypes = vi.fn()
vi.mock('@/services/providerService', () => ({
    providerService: { listTypes: (...args: unknown[]) => listTypes(...args) },
}))

import { useProviderTypes } from './useProviderTypes'
import { STATIC_PROVIDER_TYPES } from '@/services/providerTypes'

function wrapper({ children }: { children: React.ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('useProviderTypes', () => {
    it('renders the static snapshot before the catalog query resolves', () => {
        listTypes.mockReturnValue(new Promise(() => {})) // never resolves
        const { result } = renderHook(() => useProviderTypes(), { wrapper })

        expect(result.current.source).toBe('static')
        expect(result.current.types).toEqual(STATIC_PROVIDER_TYPES)
        expect(result.current.byId.falkordb).toBe(STATIC_PROVIDER_TYPES.find(t => t.id === 'falkordb'))
        expect(result.current.isLoading).toBe(true)
    })

    it('merges the live catalog with brand visuals once it resolves', async () => {
        listTypes.mockResolvedValue([
            {
                id: 'arcadedb',
                label: 'ArcadeDB',
                description: 'A PR3 provider the frontend does not know about yet.',
                docsUrl: null,
                family: 'gql',
                capabilities: { writable: true, fullCrud: true, isExternal: false, supportsCopy: false, features: [] },
                connectionShape: {
                    kind: 'generic',
                    usesHostPort: true,
                    defaultPort: 2480,
                    tls: 'none',
                    auth: 'basic',
                    databaseField: null,
                    fields: [],
                    secretCredentialKeys: [],
                    extraConfigKeys: [],
                },
                adminVisible: true,
            },
        ])
        const { result } = renderHook(() => useProviderTypes(), { wrapper })

        await waitFor(() => expect(result.current.source).toBe('backend'))
        expect(result.current.isLoading).toBe(false)
        expect(result.current.types).toHaveLength(1)
        expect(result.current.byId.arcadedb).toMatchObject({
            id: 'arcadedb',
            label: 'ArcadeDB',
            // Not in PROVIDER_VISUALS yet — renders with the neutral unknown
            // visual rather than crashing or borrowing another type's brand.
            visual: { label: 'arcadedb' },
        })
    })
})
