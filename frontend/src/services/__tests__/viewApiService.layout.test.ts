import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the HTTP layer so we can assert exactly what URL updateViewLayout builds.
vi.mock('../apiClient', () => ({
    authFetch: vi.fn().mockResolvedValue({ id: 'v1' }),
}))

import { authFetch } from '../apiClient'
import { updateViewLayout } from '../viewApiService'

const body = {
    referenceLayout: { layers: [], assignments: {} },
    entityScope: 'all' as const,
}

describe('updateViewLayout — branchId routing (BSL Phase 3)', () => {
    beforeEach(() => { vi.mocked(authFetch).mockClear() })

    it('omits ?branchId when no branch is given (base/published write)', async () => {
        await updateViewLayout('v1', body)
        expect(vi.mocked(authFetch).mock.calls[0][0]).toBe('/api/v1/views/v1/layout')
    })

    it('appends ?branchId when a draft branch is given (overlay write)', async () => {
        await updateViewLayout('v1', body, 'br_draft1')
        expect(vi.mocked(authFetch).mock.calls[0][0]).toBe('/api/v1/views/v1/layout?branchId=br_draft1')
    })

    it('url-encodes the branch id', async () => {
        await updateViewLayout('v1', body, 'br/with space')
        expect(vi.mocked(authFetch).mock.calls[0][0]).toBe('/api/v1/views/v1/layout?branchId=br%2Fwith%20space')
    })
})
