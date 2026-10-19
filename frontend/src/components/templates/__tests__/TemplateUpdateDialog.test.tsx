/**
 * Reviewing a template's new version against a view built from an older one:
 * the template's untouched changes apply, a both-changed field is the person's
 * call, applying records a template version of the view with Undo, and keeping
 * the view's layers only marks it up to date.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayoutTemplate } from '@/services/layoutTemplateService'
import type { View } from '@/services/viewApiService'
import type { ViewLayerConfig } from '@/types/schema'

const { service, viewApi, notify } = vi.hoisted(() => ({
    service: { version: vi.fn(), versions: vi.fn() },
    viewApi: { updateViewLayout: vi.fn(), setViewTemplateVersion: vi.fn() },
    notify: vi.fn(),
}))
vi.mock('@/services/layoutTemplateService', () => ({ layoutTemplateService: service }))
vi.mock('@/services/viewApiService', () => viewApi)
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/hooks/useWorkspaceEntityTypes', () => ({ useWorkspaceEntityTypes: () => ({ types: null, isLoading: false }) }))
vi.mock('@/components/ui/PersonChip', () => ({ PersonChip: ({ id }: { id: string }) => <span>{id}</span> }))

import { TemplateUpdateDialog } from '../TemplateUpdateDialog'

const L = (id: string, name: string): ViewLayerConfig => ({ id, name, color: '#111111', entityTypes: ['Table'], order: 0 })
const V1 = [L('bronze', 'Bronze'), L('silver', 'Silver'), L('gold', 'Gold')]
const V2 = [L('bronze', 'Raw'), L('silver', 'Silver'), L('gold', 'Gold+')]

// The view as the wizard made it from v1, with Gold renamed here since.
const VIEW_LAYERS = V1.map((l, i) => ({ ...l, id: `v-${l.id}`, templateLayerId: l.id, description: '', order: i }))
VIEW_LAYERS[2] = { ...VIEW_LAYERS[2], name: 'Curated' }

const VIEW = {
    id: 'view_1', name: 'Orders', workspaceId: 'ws_1', dataSourceId: 'ds_1',
    contextModelId: 'tpl_1', contextModelVersion: 1,
    config: { layout: { referenceLayout: { layers: VIEW_LAYERS, assignments: {}, defaultNodeSortMode: 'name' } } },
} as unknown as View

const TEMPLATE = { id: 'tpl_1', name: 'Medallion', version: 2, layers: V2 } as unknown as LayoutTemplate

function renderDialog(onClose = vi.fn()) {
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <MemoryRouter>
                <TemplateUpdateDialog view={VIEW} template={TEMPLATE} onClose={onClose} />
            </MemoryRouter>
        </QueryClientProvider>,
    )
    return onClose
}

beforeEach(() => {
    vi.clearAllMocks()
    service.version.mockResolvedValue({ version: 1, name: 'Medallion', layers: V1, layerCount: 3, createdAt: '' })
    service.versions.mockResolvedValue([
        { version: 2, name: 'Medallion', changeNote: 'Bronze is Raw now', layerCount: 3, createdBy: 'usr_ann', createdAt: '2026-10-17T00:00:00Z' },
        { version: 1, name: 'Medallion', changeNote: null, layerCount: 3, createdBy: 'usr_ann', createdAt: '2026-10-01T00:00:00Z' },
    ])
    viewApi.updateViewLayout.mockResolvedValue({})
    viewApi.setViewTemplateVersion.mockResolvedValue({})
})

describe('TemplateUpdateDialog', () => {
    it("says what's new and leaves only the both-changed field to the person", async () => {
        renderDialog()
        expect(await screen.findByText('Bronze is Raw now')).toBeInTheDocument()
        expect(await screen.findByText(/1 need your call/)).toBeInTheDocument()
        expect(screen.getByRole('switch', { name: 'Apply the new name of Bronze' })).toHaveAttribute('aria-checked', 'true')
        const choice = screen.getByRole('radiogroup', { name: 'Name of Curated' })
        expect(within(choice).getByRole('radio', { name: 'Keep yours' })).toHaveAttribute('aria-checked', 'true')
    })

    it('applies the chosen changes as a template version of the view, with Undo', async () => {
        const onClose = renderDialog()
        const choice = await screen.findByRole('radiogroup', { name: 'Name of Curated' })
        fireEvent.click(within(choice).getByRole('radio', { name: "Use template's" }))
        fireEvent.click(screen.getByRole('button', { name: /Apply update/ }))

        await waitFor(() => expect(viewApi.setViewTemplateVersion).toHaveBeenCalledWith('view_1', 2))
        const [viewId, body] = viewApi.updateViewLayout.mock.calls[0]
        expect(viewId).toBe('view_1')
        expect(body.referenceLayout.layers.map((l: ViewLayerConfig) => l.name)).toEqual(['Raw', 'Silver', 'Gold+'])
        expect(body.referenceLayout.defaultNodeSortMode).toBe('name')
        expect(body.checkpoint).toEqual({ source: 'template', message: 'Applied version 2 of "Medallion"' })
        expect(onClose).toHaveBeenCalled()

        const [, message, action] = notify.mock.calls.find(c => c[0] === 'success')!
        expect(message).toBe('Applied version 2 of "Medallion"')
        action.onClick()
        await waitFor(() => expect(viewApi.setViewTemplateVersion).toHaveBeenLastCalledWith('view_1', 1))
        const undone = viewApi.updateViewLayout.mock.calls[1][1]
        expect(undone.referenceLayout.layers.map((l: ViewLayerConfig) => l.name)).toEqual(['Bronze', 'Silver', 'Curated'])
    })

    it("keeps the view's own layers and only marks it up to date", async () => {
        renderDialog()
        await screen.findByText(/need your call/)
        fireEvent.click(screen.getByRole('button', { name: /Keep my layers/ }))
        await waitFor(() => expect(viewApi.setViewTemplateVersion).toHaveBeenCalledWith('view_1', 2))
        expect(viewApi.updateViewLayout).not.toHaveBeenCalled()
    })
})
