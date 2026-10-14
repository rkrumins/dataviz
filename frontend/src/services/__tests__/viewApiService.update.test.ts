/**
 * A view's name, description and tags are edited from five places: the Explorer's and the
 * workspace tab's drawer, the view page, the canvas and the wizard. Each kept its own cached
 * copy of the view, so tags saved in one were missing from the next until a reload. The
 * save refreshes every copy itself, and the conversion the wizard and canvas read carries
 * the tags.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../apiClient', () => ({
    authFetch: vi.fn().mockResolvedValue({ id: 'v1', tags: ['pii'] }),
}))

import { queryClient } from '@/lib/queryClient'
import { authFetch } from '../apiClient'
import { updateView, viewToViewConfig, type View } from '../viewApiService'

describe('updateView', () => {
    beforeEach(() => { vi.mocked(authFetch).mockClear() })

    it('refreshes every cached copy of the view', async () => {
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
        await updateView('v1', { tags: [] })
        const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey)
        // The view and each draft's read of it, the lists and their facets, its versions.
        expect(keys).toEqual(expect.arrayContaining([
            ['view', 'v1'], ['explorer-views'], ['views'], ['view-version-status', 'v1'],
        ]))
        invalidate.mockRestore()
    })

    it('sends an empty tag list, which clears them', async () => {
        await updateView('v1', { tags: [] })
        expect(JSON.parse(vi.mocked(authFetch).mock.calls[0][1]!.body as string)).toEqual({ tags: [] })
    })
})

describe('viewToViewConfig', () => {
    it('carries the tags', () => {
        const view = {
            id: 'v', name: 'n', workspaceId: 'ws', viewType: 'reference', config: {}, tags: ['finance'],
            visibility: 'private', createdAt: '', updatedAt: '',
        } as View
        expect(viewToViewConfig(view).tags).toEqual(['finance'])
        expect(viewToViewConfig({ ...view, tags: undefined }).tags).toEqual([])
    })
})
