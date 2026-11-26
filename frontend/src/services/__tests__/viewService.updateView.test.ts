/**
 * PUT /views/{id} writes the Published row and no longer writes the layout or scope, so its
 * response carries the base layout. On a draft the store holds the draft's layout, and the
 * canvas saves the store into the draft on its next gesture, so a settings save must leave the
 * store's layout and scope as they were, whether or not the visibility follow-up succeeds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSchema, ViewConfiguration } from '@/types/schema'

const updateViewMock = vi.fn()
const updateViewVisibilityMock = vi.fn()
const createViewMock = vi.fn()

vi.mock('../viewApiService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../viewApiService')>()
    return {
        ...actual,
        updateView: (...a: unknown[]) => updateViewMock(...a),
        updateViewVisibility: (...a: unknown[]) => updateViewVisibilityMock(...a),
        createView: (...a: unknown[]) => createViewMock(...a),
    }
})

import { useSchemaStore } from '@/store/schema'
import { viewService } from '../viewService'

const DRAFT_LAYOUT = { layers: [{ id: 'l_draft', name: 'Draft layer' }], assignments: {} }
const BASE_LAYOUT = { layers: [{ id: 'l_base', name: 'Base layer' }], assignments: {} }

function storeView(): ViewConfiguration {
    return {
        id: 'v1', name: 'Finance',
        content: { visibleEntityTypes: [], visibleRelationshipTypes: [], defaultDepth: 5, maxDepth: 10, entityScope: 'curated' },
        layout: { type: 'reference', referenceLayout: DRAFT_LAYOUT, lod: { enabled: false, levels: [] } },
    } as unknown as ViewConfiguration
}

const baseResponse = {
    id: 'v1', name: 'Renamed', viewType: 'reference', visibility: 'private', workspaceId: 'ws_1',
    config: {
        content: { visibleEntityTypes: [], visibleRelationshipTypes: [], defaultDepth: 5, maxDepth: 10, entityScope: 'all' },
        layout: { type: 'reference', referenceLayout: BASE_LAYOUT, lod: { enabled: false, levels: [] } },
    },
}

function stored(): ViewConfiguration {
    return useSchemaStore.getState().schema!.views.find((v) => v.id === 'v1')!
}

beforeEach(() => {
    vi.clearAllMocks()
    useSchemaStore.setState({ schema: { views: [storeView()] } as unknown as WorkspaceSchema })
    updateViewMock.mockResolvedValue(baseResponse)
})

describe('viewService.updateView', () => {
    it('keeps the store’s layout and scope when the visibility change fails', async () => {
        updateViewVisibilityMock.mockRejectedValue(new Error('forbidden'))
        const result = await viewService.updateView('v1', { name: 'Renamed', visibility: 'workspace' })
        expect(result.success).toBe(false)
        expect(stored().name).toBe('Renamed')
        expect(stored().layout.referenceLayout).toEqual(DRAFT_LAYOUT)
        expect(stored().content.entityScope).toBe('curated')
    })

    it('keeps the store’s layout and scope on success', async () => {
        const result = await viewService.updateView('v1', { name: 'Renamed' })
        expect(result.success).toBe(true)
        expect(stored().name).toBe('Renamed')
        expect(stored().layout.referenceLayout).toEqual(DRAFT_LAYOUT)
        expect(stored().content.entityScope).toBe('curated')
    })
})

describe('a settings save keeps what it does not own', () => {
    it('sends the view’s membership back as it was', async () => {
        const membership = { v: 1, mode: 'live', sources: [{ spec: { seeds: { urns: ['urn:a'] } } }] }
        await viewService.updateView('v1', { name: 'Renamed', layoutType: 'reference' }, {
            layout: { type: 'reference', referenceLayout: BASE_LAYOUT },
            content: { entityScope: 'curated' },
            membership,
        })
        const sent = updateViewMock.mock.calls[0][1] as { config: Record<string, unknown> }
        expect(sent.config.membership).toEqual(membership)
        expect((sent.config.layout as { referenceLayout: unknown }).referenceLayout).toEqual(BASE_LAYOUT)
    })
})

describe('whether a view is meant to show everything in its source', () => {
    it('a new view carries it in its config', async () => {
        createViewMock.mockResolvedValue({ ...baseResponse, config: { ...baseResponse.config, coverage: 'complete' } })
        const result = await viewService.createView({
            name: 'Finance', layoutType: 'reference', workspaceId: 'ws_1', coverage: 'complete',
        })
        const sent = createViewMock.mock.calls[0][0] as { config: Record<string, unknown> }
        expect(sent.config.coverage).toBe('complete')
        expect(result.data?.coverage).toBe('complete')
    })

    it('an edit sends it on its own, beside the config, and the store reads what was saved', async () => {
        updateViewMock.mockResolvedValue({ ...baseResponse, config: { ...baseResponse.config, coverage: 'specialised' } })
        await viewService.updateView('v1', { name: 'Renamed', coverage: 'specialised' })
        const sent = updateViewMock.mock.calls[0][1] as { coverage?: string; config: Record<string, unknown> }
        expect(sent.coverage).toBe('specialised')
        expect(stored().coverage).toBe('specialised')
    })

    it('sends none when none was chosen, so the view keeps its own', async () => {
        await viewService.updateView('v1', { name: 'Renamed' })
        const sent = updateViewMock.mock.calls[0][1] as Record<string, unknown>
        expect(sent.coverage).toBeUndefined()
        expect(stored().coverage).toBeUndefined()
    })
})
