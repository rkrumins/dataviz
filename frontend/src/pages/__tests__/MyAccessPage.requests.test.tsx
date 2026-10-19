/**
 * My Access follows every request to its end: waiting for approval (with
 * Withdraw), waiting on the identity provider (with what to ask IT), and
 * how it was answered — the role or team, an exception, an end date, a
 * reason. Someone with no workspace is pointed to Find a workspace while
 * it is on, and told whom to ask while it is off.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { access, requests, notify } = vi.hoisted(() => ({
    access: { getMyAccess: vi.fn(), listPermissions: vi.fn() },
    requests: { listMine: vi.fn(), withdraw: vi.fn() },
    notify: vi.fn(),
}))
vi.mock('@/services/permissionsService', () => ({ permissionsService: access }))
vi.mock('@/services/accessRequestsService', async (orig) => ({
    ...(await orig<typeof import('@/services/accessRequestsService')>()),
    accessRequestsService: requests,
}))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/components/account/AccountShell', () => ({
    AccountShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/access/AccessSummary', () => ({ AccessSummary: () => null }))
vi.mock('@/components/ui/PersonChip', () => ({
    PersonChip: ({ id }: { id: string }) => <span>{`person:${id}`}</span>,
}))

import { MyAccessPage } from '../MyAccessPage'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import type { AccessRequestResponse } from '@/services/accessRequestsService'

const NOBODY = {
    user: { id: 'usr_ana', email: 'ana@x.io', displayName: 'Ana', status: 'active', role: 'user' },
    directBindings: [], inheritedBindings: [], groups: [], effectiveGlobal: [], effectiveWs: {},
}

function request(over: Partial<AccessRequestResponse>): AccessRequestResponse {
    return {
        id: 'ar_x', requester: { id: 'usr_ana', email: null, displayName: null },
        target: { type: 'workspace', id: 'ws_fin', label: 'Finance' },
        requestedRole: 'workspace_member', justification: null, status: 'pending',
        createdAt: '2026-10-18T09:00:00Z', resolvedAt: null, resolvedBy: null, resolutionNote: null,
        ...over,
    }
}

function renderPage() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <MemoryRouter>
            <QueryClientProvider client={client}>
                <MyAccessPage />
            </QueryClientProvider>
        </MemoryRouter>,
    )
}

const row = (text: string | RegExp) => screen.getByText(text).closest('div.px-5') as HTMLElement

beforeEach(() => {
    vi.clearAllMocks()
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } })
    access.getMyAccess.mockResolvedValue(NOBODY)
    access.listPermissions.mockResolvedValue([])
    requests.withdraw.mockResolvedValue(request({ status: 'withdrawn' }))
})

describe('MyAccessPage — your requests', () => {
    it('says where each request stands and how it was answered', async () => {
        requests.listMine.mockResolvedValue([
            request({ id: 'ar_1', target: { type: 'workspace', id: 'ws_fin', label: 'Finance' } }),
            request({
                id: 'ar_2', status: 'awaiting_idp', target: { type: 'workspace', id: 'ws_risk', label: 'Risk' },
                idpGroup: 'risk-analysts', idpProvider: 'Entra ID', resolvedBy: 'usr_bob', resolvedAt: '2026-10-18T10:00:00Z',
            }),
            request({
                id: 'ar_3', status: 'approved', target: { type: 'workspace', id: 'ws_ops', label: 'Operations' },
                grantedRole: 'workspace_viewer', idpException: true, accessExpiresAt: '2026-11-17T00:00:00Z',
                resolvedBy: 'usr_wanda', resolvedAt: '2026-10-18T11:00:00Z', resolutionNote: 'Welcome aboard',
            }),
            request({
                id: 'ar_4', status: 'denied', target: { type: 'workspace', id: 'ws_hr', label: null },
                resolutionNote: 'HR is closed to contractors', resolvedBy: 'usr_bob', resolvedAt: '2026-10-18T12:00:00Z',
            }),
            request({ id: 'ar_5', status: 'withdrawn', target: { type: 'workspace', id: 'ws_eng', label: 'Engineering' } }),
        ])
        renderPage()

        expect(await screen.findByText('2 open')).toBeInTheDocument()
        const finance = row('Finance')
        expect(within(finance).getByText('Waiting for approval')).toBeInTheDocument()
        expect(within(finance).getByRole('button', { name: /Withdraw/ })).toBeInTheDocument()

        const risk = row('Risk')
        expect(within(risk).getByText(/Ask your IT team to add you to “risk-analysts” in Entra ID/)).toBeInTheDocument()
        expect(within(risk).getByText('person:usr_bob')).toBeInTheDocument()

        const ops = row('Operations')
        expect(within(ops).getByText(/Granted Viewer as an exception until/)).toBeInTheDocument()
        expect(within(ops).getByText('“Welcome aboard”')).toBeInTheDocument()
        expect(within(ops).getByRole('link', { name: /Open/ })).toHaveAttribute('href', '/workspaces/ws_ops')
        expect(within(ops).queryByRole('button', { name: /Withdraw/ })).not.toBeInTheDocument()

        // A workspace the requester can't see stays unnamed.
        const hr = row(/A workspace you asked to join/)
        expect(within(hr).getByText('Reason: HR is closed to contractors')).toBeInTheDocument()

        expect(within(row('Engineering')).getByText('You withdrew it.')).toBeInTheDocument()
    })

    it('withdraws an open request', async () => {
        const user = userEvent.setup()
        requests.listMine.mockResolvedValue([request({ id: 'ar_1' })])
        renderPage()
        await user.click(await screen.findByRole('button', { name: /Withdraw/ }))
        await waitFor(() => expect(requests.withdraw).toHaveBeenCalledWith('ar_1'))
        expect(notify).toHaveBeenCalledWith('success', 'Request withdrawn.')
    })
})

describe('MyAccessPage — no workspace yet', () => {
    it('points to Find a workspace while it is on', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, workspaceDirectoryEnabled: true } })
        requests.listMine.mockResolvedValue([])
        renderPage()
        expect(await screen.findByRole('link', { name: 'Find a workspace' })).toHaveAttribute('href', '/workspaces?tab=discover')
    })

    it('says whom to ask while it is off', async () => {
        requests.listMine.mockResolvedValue([])
        renderPage()
        expect(await screen.findByText(/Ask an administrator to add you to a workspace/)).toBeInTheDocument()
        expect(screen.queryByRole('link', { name: 'Find a workspace' })).not.toBeInTheDocument()
    })

    it('reads the permission catalogue quietly — most people may not', async () => {
        requests.listMine.mockResolvedValue([])
        renderPage()
        await screen.findByText(/Ask an administrator to add you to a workspace/)
        expect(access.listPermissions).toHaveBeenCalledWith({ silent403: true })
    })
})
