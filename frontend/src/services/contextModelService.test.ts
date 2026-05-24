/**
 * Tests for the template-management functions added to
 * services/contextModelService.ts.
 *
 * The intent is contract verification: each function hits the right URL
 * with the right verb and body. We mock fetchWithTimeout to capture the
 * call shape without crossing the network.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mock before importing the module under test.
vi.mock('./fetchWithTimeout', () => ({
    fetchWithTimeout: vi.fn(),
}))

import { fetchWithTimeout } from './fetchWithTimeout'
import {
    listAllTemplates,
    getTemplate,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    duplicateTemplate,
    importTemplate,
    getTemplateUsage,
} from './contextModelService'

const mockFetch = fetchWithTimeout as unknown as ReturnType<typeof vi.fn>

function okJson(body: unknown) {
    return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
    }
}

beforeEach(() => {
    mockFetch.mockReset()
})

describe('template service', () => {
    it('listAllTemplates builds a query string from filter fields', async () => {
        mockFetch.mockResolvedValue(okJson([]))
        await listAllTemplates({
            scope: 'workspace',
            workspaceId: 'ws_1',
            category: 'analytics',
            tag: 'etl',
            search: 'pipe',
            sort: 'popular',
        })
        expect(mockFetch).toHaveBeenCalledTimes(1)
        const [url] = mockFetch.mock.calls[0]
        expect(url).toContain('/api/v1/context-model-templates?')
        expect(url).toContain('scope=workspace')
        expect(url).toContain('workspaceId=ws_1')
        expect(url).toContain('category=analytics')
        expect(url).toContain('tag=etl')
        expect(url).toContain('search=pipe')
        expect(url).toContain('sort=popular')
    })

    it('listAllTemplates emits no query string when no filters are set', async () => {
        mockFetch.mockResolvedValue(okJson([]))
        await listAllTemplates({})
        const [url] = mockFetch.mock.calls[0]
        expect(url).toBe('/api/v1/context-model-templates')
    })

    it('getTemplate uses the detail URL', async () => {
        mockFetch.mockResolvedValue(okJson({ id: 'cm_1' }))
        await getTemplate('cm_1')
        expect(mockFetch.mock.calls[0][0]).toBe('/api/v1/context-model-templates/cm_1')
    })

    it('createTemplate forces isTemplate=true in the payload', async () => {
        mockFetch.mockResolvedValue(okJson({ id: 'cm_new' }))
        await createTemplate({
            name: 'X',
            layersConfig: [],
            isTemplate: false,  // explicitly false; service should overwrite
        })
        const [, opts] = mockFetch.mock.calls[0]
        expect(opts!.method).toBe('POST')
        const body = JSON.parse(opts!.body as string)
        expect(body.isTemplate).toBe(true)
        expect(body.name).toBe('X')
    })

    it('updateTemplate sends a PUT with the body intact', async () => {
        mockFetch.mockResolvedValue(okJson({ id: 'cm_1' }))
        await updateTemplate('cm_1', { name: 'Renamed', tags: ['a'] })
        const [url, opts] = mockFetch.mock.calls[0]
        expect(url).toBe('/api/v1/context-model-templates/cm_1')
        expect(opts!.method).toBe('PUT')
        expect(JSON.parse(opts!.body as string)).toEqual({ name: 'Renamed', tags: ['a'] })
    })

    it('deleteTemplate soft-deletes by default and supports permanent=true', async () => {
        mockFetch.mockResolvedValue({ ok: true, status: 204 })
        await deleteTemplate('cm_1')
        expect(mockFetch.mock.calls[0][0]).toBe('/api/v1/context-model-templates/cm_1')
        expect(mockFetch.mock.calls[0][1]!.method).toBe('DELETE')

        await deleteTemplate('cm_2', { permanent: true })
        expect(mockFetch.mock.calls[1][0]).toBe('/api/v1/context-model-templates/cm_2?permanent=true')
    })

    it('duplicateTemplate posts the new name + workspace scope', async () => {
        mockFetch.mockResolvedValue(okJson({ id: 'cm_dup' }))
        await duplicateTemplate('cm_1', 'Copy of X', 'ws_a')
        const [url, opts] = mockFetch.mock.calls[0]
        expect(url).toBe('/api/v1/context-model-templates/cm_1/duplicate')
        expect(opts!.method).toBe('POST')
        expect(JSON.parse(opts!.body as string)).toEqual({ name: 'Copy of X', workspaceId: 'ws_a' })
    })

    it('duplicateTemplate sends null workspaceId for global', async () => {
        mockFetch.mockResolvedValue(okJson({ id: 'cm_dup' }))
        await duplicateTemplate('cm_1', 'Global Copy')
        expect(JSON.parse(mockFetch.mock.calls[0][1]!.body as string)).toEqual({
            name: 'Global Copy',
            workspaceId: null,
        })
    })

    it('importTemplate wraps the payload and forces isTemplate', async () => {
        mockFetch.mockResolvedValue(okJson({ id: 'cm_imp' }))
        await importTemplate({ name: 'Imported', layersConfig: [], isTemplate: false })
        const [url, opts] = mockFetch.mock.calls[0]
        expect(url).toBe('/api/v1/context-model-templates/import')
        expect(opts!.method).toBe('POST')
        const body = JSON.parse(opts!.body as string)
        expect(body).toHaveProperty('payload')
        expect(body.payload.isTemplate).toBe(true)
        expect(body.payload.name).toBe('Imported')
    })

    it('getTemplateUsage hits the usage subresource', async () => {
        mockFetch.mockResolvedValue(okJson({
            templateId: 'cm_1',
            instantiationCount: 5,
            instancesByWorkspace: { ws_a: 3, ws_b: 2 },
        }))
        const stats = await getTemplateUsage('cm_1')
        expect(mockFetch.mock.calls[0][0]).toBe('/api/v1/context-model-templates/cm_1/usage')
        expect(stats.instantiationCount).toBe(5)
    })
})
