/**
 * The connection editor: presets prefill the usual values for a kind of
 * endpoint, and what is saved is exactly the draft — a configured secret
 * left alone is not sent, a removed one is cleared.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthTypeFields, Connection } from '@/services/aiAdminService'
import { ConnectionEditorDrawer } from '../connections/ConnectionEditorDrawer'
import {
    AZURE_API_VERSION, PRESETS, applyPreset, connectionErrors, emptyConnection, toConnectionInput, withAzurePaths,
} from '../connections/useConnectionEditor'

const FIELDS: AuthTypeFields = {
    none: { config: [], secrets: [] },
    api_key: { config: ['header', 'prefix', 'in', 'param'], secrets: ['apiKey'] },
    bearer: { config: [], secrets: ['token'] },
    basic: { config: ['username'], secrets: ['password'] },
    oauth2_client_credentials: { config: ['tokenUrl', 'clientId', 'scope', 'audience', 'clientAuth'], secrets: ['clientSecret'] },
    token_mint: {
        config: ['tokenUrl', 'method', 'bodyFormat', 'body', 'headers', 'basicAuth', 'username', 'clientId',
            'tokenPath', 'expiresPath', 'tokenHeader', 'tokenPrefix', 'defaultTtlSeconds'],
        secrets: ['password', 'clientSecret'],
    },
}

const { svc, notify } = vi.hoisted(() => ({
    svc: { authTypes: vi.fn(), createConnection: vi.fn(), updateConnection: vi.fn() },
    notify: vi.fn(),
}))
vi.mock('@/services/aiAdminService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/services/aiAdminService')>()
    return { ...actual, aiAdminService: svc }
})
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))

const preset = (id: string) => PRESETS.find(p => p.id === id)!

const STORED: Connection = {
    id: 'llm_1', name: 'Azure prod', kind: 'openai_compatible', baseUrl: 'https://res.openai.azure.com',
    authType: 'api_key', authConfig: { header: 'api-key', prefix: '', in: 'header' },
    secrets: { apiKey: { configured: true } }, extraHeaders: {},
    options: { chatPath: '/openai/deployments/{model}/chat/completions', queryParams: { 'api-version': '2024-10-21' } },
    models: { chat: 'gpt4o-prod' }, capabilities: {}, enabled: true, lastTest: null,
    createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
}

const renderDrawer = (connection: Connection | null) => render(
    <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <ConnectionEditorDrawer connection={connection} onClose={vi.fn()} onSaved={vi.fn()} />
        </QueryClientProvider>
    </MemoryRouter>,
)

beforeEach(() => {
    vi.clearAllMocks()
    svc.authTypes.mockResolvedValue(FIELDS)
    svc.createConnection.mockImplementation(async (b: object) => ({ ...STORED, ...b, id: 'llm_new' }))
    svc.updateConnection.mockImplementation(async (_id: string, b: object) => ({ ...STORED, ...b }))
})

describe('presets', () => {
    it('OpenAI: its API, a bearer API key and the usual models', () => {
        const d = applyPreset(emptyConnection(), preset('openai'))
        expect(d.baseUrl).toBe('https://api.openai.com/v1')
        expect(d.auth).toMatchObject({ authType: 'api_key', config: { header: 'Authorization', prefix: 'Bearer' } })
        expect(d.models.chat).toBeTruthy()
        expect(d.models.embedding).toBeTruthy()
    })

    it('Azure OpenAI: deployment paths, an api-version, and the api-key header with no prefix', () => {
        const input = toConnectionInput({ ...applyPreset(emptyConnection(), preset('azure')), baseUrl: 'https://r.openai.azure.com' }, FIELDS)
        expect(input.authConfig).toEqual({ in: 'header', header: 'api-key', prefix: '' })
        expect(input.options).toMatchObject({
            chatPath: '/openai/deployments/{model}/chat/completions',
            embeddingsPath: '/openai/deployments/{model}/embeddings',
            queryParams: { 'api-version': AZURE_API_VERSION },
        })
    })

    it('local server: no sign-in; gateway: a token mint with its request template', () => {
        expect(applyPreset(emptyConnection(), preset('local')).auth.authType).toBe('none')
        const gw = applyPreset(emptyConnection(), preset('gateway'))
        expect(gw.auth.authType).toBe('token_mint')
        expect(String(gw.auth.config.body)).toContain('{{password}}')
    })

    it('keeps a name already typed, and the Azure paths replace an api-version rather than add a second', () => {
        expect(applyPreset({ ...emptyConnection(), name: 'Mine' }, preset('openai')).name).toBe('Mine')
        const twice = withAzurePaths(withAzurePaths({ ...emptyConnection(), queryParams: [{ key: 'api-version', value: 'old' }] }))
        expect(twice.queryParams).toEqual([{ key: 'api-version', value: AZURE_API_VERSION }])
    })

    it('a preset leaves what only a person can know to them', () => {
        const errors = connectionErrors(applyPreset(emptyConnection(), preset('azure')), FIELDS)
        expect(errors.baseUrl).toBeTruthy()
        expect(errors.chat).toBeTruthy()
    })
})

describe('the drawer', () => {
    it('adds a connection from a preset', async () => {
        renderDrawer(null)
        await userEvent.click(await screen.findByRole('button', { name: /^OpenAI/ }))
        await userEvent.type(screen.getByLabelText(/^API key/), 'sk-test')
        await userEvent.click(screen.getByRole('button', { name: /add connection/i }))
        await waitFor(() => expect(svc.createConnection).toHaveBeenCalledTimes(1))
        expect(svc.createConnection.mock.calls[0][0]).toMatchObject({
            name: 'OpenAI', kind: 'openai_compatible', baseUrl: 'https://api.openai.com/v1',
            authType: 'api_key', secrets: { apiKey: 'sk-test' }, enabled: true,
            options: { stream: true, tools: true },
        })
        expect(notify).toHaveBeenCalledWith('success', expect.stringContaining('Added OpenAI'))
    })

    it('saves an edit without the stored secret, and clears it when removed', async () => {
        renderDrawer(STORED)
        expect(await screen.findByText('Configured — leave as-is to keep it')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: 'Remove api key' }))
        await userEvent.click(screen.getByRole('button', { name: /save changes/i }))
        await waitFor(() => expect(svc.updateConnection).toHaveBeenCalledTimes(1))
        const [id, body] = svc.updateConnection.mock.calls[0]
        expect(id).toBe('llm_1')
        expect(body.secretsClear).toEqual(['apiKey'])
        expect(body.secrets).toBeUndefined()
        expect(JSON.stringify(body)).not.toContain('********')
        expect(body.options.queryParams).toEqual({ 'api-version': '2024-10-21' })
    })

    it('saves a renamed connection with no secrets at all', async () => {
        renderDrawer(STORED)
        const name = await screen.findByLabelText(/^Name/)
        await userEvent.clear(name)
        await userEvent.type(name, 'Azure (prod)')
        expect(screen.getByText('1 unsaved change')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: /save changes/i }))
        await waitFor(() => expect(svc.updateConnection).toHaveBeenCalled())
        const body = svc.updateConnection.mock.calls[0][1]
        expect(body.name).toBe('Azure (prod)')
        expect(body).not.toHaveProperty('secrets')
        expect(body).not.toHaveProperty('secretsClear')
    })

    it('will not save until the fields marked in red are fixed', async () => {
        renderDrawer(STORED)
        const chat = await screen.findByLabelText(/^Chat model/)
        await userEvent.clear(chat)
        expect(screen.getByText('Name the model that answers questions.')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled()
    })
})
