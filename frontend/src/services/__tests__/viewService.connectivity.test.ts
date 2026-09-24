import { describe, it, expect, vi, beforeEach } from 'vitest'

// The builder rebuilds `content` wholesale from the request, which never
// mentions virtual hops — so a plain metadata save must carry the stored
// connectivity through, or saving a subset's name would switch its hops off.
vi.mock('../viewApiService', () => ({
    updateView: vi.fn().mockResolvedValue({ id: 'v1', visibility: 'private' }),
    updateViewVisibility: vi.fn(),
    viewToViewConfig: vi.fn((v: unknown) => v),
}))

import * as viewApi from '../viewApiService'
import { viewService } from '../viewService'

describe('viewService.updateView — a subset keeps its virtual hops', () => {
    beforeEach(() => { vi.mocked(viewApi.updateView).mockClear() })

    it('carries content.connectivity from the stored config', async () => {
        await viewService.updateView('v1', { name: 'Renamed', layoutType: 'reference' }, {
            content: { entityScope: 'curated', connectivity: { mode: 'bridged', maxHops: 6 } },
            layout: { referenceLayout: { layers: [], assignments: {} } },
        })
        const sent = vi.mocked(viewApi.updateView).mock.calls[0][1] as { config: { content: Record<string, unknown> } }
        expect(sent.config.content.connectivity).toEqual({ mode: 'bridged', maxHops: 6 })
        expect(sent.config.content.entityScope).toBe('curated')
    })

    it('adds nothing to a view that never had any', async () => {
        await viewService.updateView('v1', { name: 'Plain', layoutType: 'reference' }, {
            content: { entityScope: 'all' },
            layout: { referenceLayout: { layers: [], assignments: {} } },
        })
        const sent = vi.mocked(viewApi.updateView).mock.calls[0][1] as { config: { content: Record<string, unknown> } }
        expect('connectivity' in sent.config.content).toBe(false)
    })
})
