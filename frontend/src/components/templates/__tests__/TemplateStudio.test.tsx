/**
 * The guided studio: a new template walks Start → Basics → Layers → Audience →
 * Review and is created with exactly what was chosen; Next waits for a valid
 * step; editing sends a new audience only when it changed.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayoutTemplate } from '@/services/layoutTemplateService'

const { service, notify, wsState } = vi.hoisted(() => ({
    service: { list: vi.fn(), create: vi.fn(), update: vi.fn() },
    notify: vi.fn(),
    wsState: { workspaces: [] as { id: string; name: string; dataSources: unknown[] }[] },
}))

vi.mock('@/services/layoutTemplateService', () => ({ layoutTemplateService: service }))
vi.mock('@/services/viewApiService', () => ({ listViews: vi.fn().mockResolvedValue({ items: [], total: 0 }) }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/store/workspaces', () => {
    const useWorkspacesStore = Object.assign(
        (selector: (s: typeof wsState) => unknown) => selector(wsState),
        { getState: () => wsState },
    )
    return { useWorkspacesStore }
})

import { useAuthStore } from '@/store/auth'
import { TemplateStudio } from '../TemplateStudio'

const MINE: LayoutTemplate = {
    id: 'tpl_mine', name: 'My flow', description: 'Orders', category: 'finance', visibility: 'private',
    builtIn: false, hidden: false, workspaceId: null, workspaceName: null, createdBy: 'usr_me',
    createdAt: '', updatedAt: '', usageCount: 0, grantCount: 0, version: 1,
    layers: [{ id: 'l1', name: 'Sources', entityTypes: ['Table'], order: 0, color: '#3b82f6' }],
    access: { via: 'owner', canEdit: true, canDelete: true, canShare: true, canHide: false },
}

function renderStudio(props: Partial<Parameters<typeof TemplateStudio>[0]> = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={client}>
            <MemoryRouter>
                <TemplateStudio seed={{}} categories={['finance']} onClose={vi.fn()} {...props} />
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

const next = () => fireEvent.click(screen.getByRole('button', { name: /^next/i }))

beforeEach(() => {
    vi.clearAllMocks()
    service.list.mockResolvedValue({ items: [], total: 0 })
    wsState.workspaces = [{ id: 'ws_fin', name: 'Finance', dataSources: [] }]
    useAuthStore.setState({ permissions: { global: [], ws: { ws_fin: ['workspace:view:create'] } } } as never)
})

describe('TemplateStudio', () => {
    it('creates a template with exactly what was chosen', async () => {
        service.create.mockImplementation(async (body: Record<string, unknown>) => ({ ...MINE, ...body, id: 'tpl_new' }))
        const onUse = vi.fn()
        renderStudio({ onUse })

        expect(screen.getByText('Where would you like to start?')).toBeInTheDocument()
        next()
        const name = await screen.findByPlaceholderText('e.g. Finance reporting flow')
        expect(screen.getByRole('button', { name: /^next/i })).toBeDisabled()
        fireEvent.change(name, { target: { value: '  Orders flow ' } })
        next()
        expect(await screen.findByText('Shape the layers')).toBeInTheDocument()
        // No data of theirs to read: no preview to offer.
        expect(screen.queryByRole('button', { name: /preview with real data/i })).not.toBeInTheDocument()
        next()
        expect(await screen.findByText('Who is it for?')).toBeInTheDocument()
        expect(screen.getByRole('radio', { name: /Organization/ })).toBeDisabled()
        next()
        expect(await screen.findByText('One last look')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /create template/i }))

        await waitFor(() => expect(service.create).toHaveBeenCalledTimes(1))
        const body = service.create.mock.calls[0][0]
        expect(body).toMatchObject({ name: 'Orders flow', description: null, category: null, visibility: 'private', workspaceId: null })
        expect(body.layers.map((l: { name: string; order: number }) => [l.name, l.order]))
            .toEqual([['Layer 1', 0], ['Layer 2', 1], ['Layer 3', 2]])

        expect(await screen.findByText('"Orders flow" is ready')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /use it for a new view/i }))
        expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ id: 'tpl_new' }))
    })

    it('offers a preview with real data while the layers take shape', async () => {
        wsState.workspaces = [{ id: 'ws_fin', name: 'Finance', dataSources: [{ id: 'ds_fin', isPrimary: true }] }]
        useAuthStore.setState({ permissions: { global: [], ws: { ws_fin: ['workspace:datasource:read'] } } } as never)
        renderStudio({ seed: { template: MINE } })
        next()
        expect(await screen.findByText('Shape the layers')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /preview with real data/i })).toHaveAttribute('aria-expanded', 'false')
    })

    it('editing moves the template only when its audience changed', async () => {
        service.update.mockResolvedValue({ ...MINE, visibility: 'workspace', workspaceId: 'ws_fin' })
        const onClose = vi.fn()
        renderStudio({ seed: { template: MINE }, onClose })

        expect(screen.getByDisplayValue('My flow')).toBeInTheDocument()
        next()
        await screen.findByText('Shape the layers')
        next()
        await screen.findByText('Who is it for?')
        fireEvent.click(screen.getByRole('radio', { name: /Workspace/ }))
        expect(screen.getByRole('combobox')).toHaveValue('ws_fin')
        next()
        await screen.findByText('One last look')
        fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

        await waitFor(() => expect(service.update).toHaveBeenCalledTimes(1))
        const [id, body] = service.update.mock.calls[0]
        expect(id).toBe('tpl_mine')
        expect(body).toMatchObject({ name: 'My flow', visibility: 'workspace', workspaceId: 'ws_fin' })
        await waitFor(() => expect(onClose).toHaveBeenCalled())
    })

    it('editing content alone leaves the audience out of the request', async () => {
        service.update.mockResolvedValue(MINE)
        renderStudio({ seed: { template: MINE } })
        fireEvent.change(screen.getByDisplayValue('My flow'), { target: { value: 'Our flow' } })
        for (const heading of ['Shape the layers', 'Who is it for?', 'One last look']) {
            next()
            await screen.findByText(heading)
        }
        fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
        await waitFor(() => expect(service.update).toHaveBeenCalledTimes(1))
        const body = service.update.mock.calls[0][1]
        expect(body.name).toBe('Our flow')
        expect(body).not.toHaveProperty('visibility')
        // The layers did not change: no new version, so nothing to say about one.
        expect(body).not.toHaveProperty('changeNote')
        expect(screen.queryByText(/This saves version/)).not.toBeInTheDocument()
    })

    it('new layers are a new version: say what changed, and tell the people using it', async () => {
        const shared = { ...MINE, visibility: 'workspace' as const, workspaceId: 'ws_fin', usageCount: 3 }
        service.update.mockResolvedValue({ ...shared, version: 2 })
        renderStudio({ seed: { template: shared } })
        next()
        await screen.findByText('Shape the layers')
        fireEvent.change(screen.getByDisplayValue('Sources'), { target: { value: 'Raw sources' } })
        next()
        await screen.findByText('Who is it for?')
        next()
        expect(await screen.findByText('This saves version 2')).toBeInTheDocument()
        fireEvent.change(screen.getByPlaceholderText(/Added a Gold layer/), { target: { value: 'Renamed Sources' } })
        expect(screen.getByRole('checkbox', { name: /Tell the people/ })).toBeChecked()
        fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

        await waitFor(() => expect(service.update).toHaveBeenCalledTimes(1))
        expect(service.update.mock.calls[0][1]).toMatchObject({ changeNote: 'Renamed Sources', notifyUsers: true })
    })
})
