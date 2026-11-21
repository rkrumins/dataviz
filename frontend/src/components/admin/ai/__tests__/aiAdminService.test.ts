/**
 * The administration calls reach the contract's routes with the right
 * methods, and a refusal surfaces the server's own message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.mock('@/services/fetchWithTimeout', () => ({ fetchWithTimeout: fetchMock }))

import { aiAdminService } from '@/services/aiAdminService'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => fetchMock.mockReset())

describe('aiAdminService', () => {
    it('lists connections and unwraps the items', async () => {
        fetchMock.mockResolvedValue(json({ items: [{ id: 'llm_1' }] }))
        expect(await aiAdminService.listConnections()).toEqual([{ id: 'llm_1' }])
        expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/ai/admin/connections')
    })

    it('patches a connection with the body as given, and tests it', async () => {
        fetchMock.mockImplementation(async () => json({ id: 'llm_1' }))
        await aiAdminService.updateConnection('llm_1', { name: 'x', secretsClear: ['apiKey'] })
        expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/ai/admin/connections/llm_1')
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ name: 'x', secretsClear: ['apiKey'] }) })
        await aiAdminService.testConnection('llm_1')
        expect(fetchMock.mock.calls[1]).toEqual(['/api/v1/ai/admin/connections/llm_1/test', expect.objectContaining({ method: 'POST' })])
    })

    it('starts a re-index, which answers 202', async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 202 }))
        await expect(aiAdminService.reindex('views')).resolves.toBeUndefined()
        expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/ai/admin/knowledge/views/reindex')
    })

    it('asks for one data source’s vocabulary, and promotes a mapping', async () => {
        fetchMock.mockImplementation(async () => json({ items: [] }))
        await aiAdminService.listConcepts('ds 1')
        expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/ai/admin/concepts?dataSourceId=ds%201')
        await aiAdminService.promoteConcept('cm_1')
        expect(fetchMock.mock.calls[1]).toEqual(['/api/v1/ai/admin/concepts/cm_1/promote', expect.objectContaining({ method: 'POST' })])
    })

    it('throws the server’s message on a refusal', async () => {
        fetchMock.mockResolvedValue(json({ detail: { code: 'invalid', message: 'Name the chat model (models.chat).' } }, 400))
        await expect(aiAdminService.createConnection({})).rejects.toThrow('Name the chat model (models.chat).')
    })
})
