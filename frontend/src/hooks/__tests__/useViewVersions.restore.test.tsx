/**
 * useRestoreViewVersion — a restore rewrites the view's design, its display
 * rules among it: a canvas that has the view open reads its library again.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ restoreViewVersion: vi.fn(), reloadViewLibrary: vi.fn() }))
vi.mock('@/services/viewVersionsApiService', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    restoreViewVersion: api.restoreViewVersion,
}))
vi.mock('@/store/viewLibraryStore', () => ({ reloadViewLibrary: api.reloadViewLibrary }))

import { useRestoreViewVersion } from '../useViewVersions'


function wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}


beforeEach(() => {
    api.restoreViewVersion.mockReset()
    api.reloadViewLibrary.mockReset()
})


describe('useRestoreViewVersion', () => {
    it("reads the view's library again once the restore is done", async () => {
        api.restoreViewVersion.mockResolvedValue({})
        const { result } = renderHook(() => useRestoreViewVersion('view-1'), { wrapper })
        await act(() => result.current.mutateAsync(3))
        expect(api.restoreViewVersion).toHaveBeenCalledWith('view-1', 3)
        expect(api.reloadViewLibrary).toHaveBeenCalledWith('view-1')
    })

    it('leaves the library alone when the restore is refused', async () => {
        api.restoreViewVersion.mockRejectedValue(new Error('Conflict'))
        const { result } = renderHook(() => useRestoreViewVersion('view-1'), { wrapper })
        await act(async () => { await expect(result.current.mutateAsync(3)).rejects.toThrow('Conflict') })
        expect(api.reloadViewLibrary).not.toHaveBeenCalled()
    })
})
