/**
 * Testing a connection: each check — answers, calls a tool, makes
 * embeddings — with its latency and what came back, and what the assistant
 * can therefore do with it. Started from the connection's row in the list.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Connection, TestReport } from '@/services/aiAdminService'
import { TestReportView } from '../connections/TestReportView'
import { ConnectionsTab } from '../connections/ConnectionsTab'
import { capabilityBadges } from '../connections/connectionFormat'

const { svc, notify } = vi.hoisted(() => ({
    svc: { listConnections: vi.fn(), getSettings: vi.fn(), testConnection: vi.fn(), deleteConnection: vi.fn(), authTypes: vi.fn() },
    notify: vi.fn(),
}))
vi.mock('@/services/aiAdminService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/services/aiAdminService')>()
    return { ...actual, aiAdminService: svc }
})
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))

const REPORT: TestReport = {
    ok: true,
    checks: [
        { name: 'answer', ok: true, latencyMs: 412, detail: { model: 'gpt-4o-2024-08-06', reply: 'ok' } },
        { name: 'tools', ok: false, latencyMs: 1290, detail: 'The model answered without calling the tool.', code: 'protocol' },
        { name: 'embeddings', ok: true, latencyMs: 88, detail: { dimensions: 1536 } },
    ],
    capabilities: { tools: false, nativeTools: false, streaming: true, embeddings: true, embeddingDimensions: 1536 },
}

const CONNECTION: Connection = {
    id: 'llm_1', name: 'Corp gateway', kind: 'openai_compatible', baseUrl: 'https://llm.corp.example.com/v1',
    authType: 'token_mint', authConfig: {}, secrets: { password: { configured: true } }, extraHeaders: {}, options: {},
    models: { chat: 'gpt-4o', embedding: 'text-embedding-3-small' }, capabilities: {}, enabled: true,
    lastTest: { at: '2026-11-20T10:00:00Z', status: 'failed', detail: 'The token endpoint refused the credentials.' },
    createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
}

describe('the test report', () => {
    it('lists each check with its latency and what came back, a failure in its own words', () => {
        render(<TestReportView report={REPORT} />)
        const result = screen.getByRole('status', { name: 'Test result' })
        expect(result).toHaveTextContent('The connection works.')
        const items = within(result).getAllByRole('listitem')
        expect(items[0]).toHaveTextContent('Answers a question')
        expect(items[0]).toHaveTextContent('412 ms')
        expect(items[0]).toHaveTextContent('model: gpt-4o-2024-08-06 · reply: ok')
        expect(items[1]).toHaveTextContent('Calls a tool')
        expect(items[1]).toHaveTextContent('1,290 ms')
        expect(items[1]).toHaveTextContent('The model answered without calling the tool. (protocol)')
        expect(within(items[1]).getByLabelText('Failed')).toBeInTheDocument()
        expect(items[2]).toHaveTextContent('Makes embeddings')
        expect(within(items[2]).getByLabelText('Passed')).toBeInTheDocument()
    })

    it('sums up what the assistant can do with it', () => {
        render(<TestReportView report={REPORT} />)
        expect(screen.getByText(/No tool calling/)).toBeInTheDocument()
        expect(screen.getByText('Answers stream as they are written')).toBeInTheDocument()
        expect(screen.getByText('Yes, 1,536 dimensions')).toBeInTheDocument()
    })

    it('says so when the connection could not answer', () => {
        render(<TestReportView report={{ ok: false, checks: [{ name: 'answer', ok: false, latencyMs: 30, detail: 'HTTP 401' }] }} />)
        expect(screen.getByRole('status')).toHaveTextContent('The connection could not answer.')
    })

    it('badges what a connection was found able to do', () => {
        expect(capabilityBadges({}).map(b => b.label)).toEqual(['Not tested yet'])
        expect(capabilityBadges({ tools: true, nativeTools: true, embeddings: true }).map(b => b.label)).toEqual(['Tools native', 'Embeddings'])
        expect(capabilityBadges({ tools: true, nativeTools: false }).map(b => b.label)).toEqual(['JSON protocol'])
        expect(capabilityBadges({ tools: false }).map(b => b.label)).toEqual(['No tools'])
    })
})

describe('the connection list', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        svc.listConnections.mockResolvedValue([CONNECTION])
        svc.getSettings.mockResolvedValue({ chatConnectionId: 'llm_1', fastConnectionId: null, embeddingConnectionId: 'llm_1' })
        svc.testConnection.mockResolvedValue(REPORT)
    })

    const renderTab = () => render(
        <MemoryRouter>
            <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                <ConnectionsTab adding={false} onAddingChange={vi.fn()} />
            </QueryClientProvider>
        </MemoryRouter>,
    )

    it('shows each connection’s host, sign-in, models, what it is used for and its last test', async () => {
        renderTab()
        const row = (await screen.findByRole('button', { name: 'Corp gateway' })).closest('tr')!
        expect(row).toHaveTextContent('llm.corp.example.com')
        expect(row).toHaveTextContent('Token from a sign-in endpoint')
        expect(row).toHaveTextContent('gpt-4o')
        expect(row).toHaveTextContent('embed: text-embedding-3-small')
        expect(row).toHaveTextContent('Not tested yet')
        expect(row).toHaveTextContent('Failed')
        expect(await within(row).findByText('Used for answering questions, embeddings')).toBeInTheDocument()
    })

    it('tests a connection from its row and shows the report under it', async () => {
        renderTab()
        await userEvent.click(await screen.findByRole('button', { name: 'Test' }))
        expect(svc.testConnection).toHaveBeenCalledWith('llm_1')
        expect(await screen.findByRole('status', { name: 'Test result' })).toHaveTextContent('Answers a question')
    })

    it('deletes only after the name is typed, and says which roles lose their connection', async () => {
        svc.deleteConnection.mockResolvedValue(undefined)
        renderTab()
        await userEvent.click(await screen.findByRole('button', { name: 'Delete Corp gateway' }))
        expect(await screen.findByText(/left without a connection/)).toBeInTheDocument()
        const confirm = screen.getByRole('button', { name: 'Delete' })
        expect(confirm).toBeDisabled()
        await userEvent.type(screen.getByPlaceholderText('Corp gateway'), 'Corp gateway')
        await userEvent.click(confirm)
        expect(svc.deleteConnection).toHaveBeenCalledWith('llm_1')
    })
})
