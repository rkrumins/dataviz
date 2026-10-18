/**
 * Importing a template file: what is in it is shown before anything is
 * created, a name the library already has is kept apart, a file that isn't a
 * template says why, and the new template is created with the chosen audience.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { service, notify, wsState } = vi.hoisted(() => ({
    service: { create: vi.fn() },
    notify: vi.fn(),
    wsState: {
        activeWorkspaceId: 'ws_fin',
        workspaces: [{ id: 'ws_fin', name: 'Finance', dataSources: [{ id: 'ds_fin', isPrimary: true }] }] as unknown[],
    },
}))

vi.mock('@/services/layoutTemplateService', () => ({ layoutTemplateService: service }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/hooks/useWorkspaceEntityTypes', () => ({
    useWorkspaceEntityTypes: () => ({ types: ['Table'], isLoading: false, isError: false }),
}))
vi.mock('@/store/workspaces', () => {
    const useWorkspacesStore = Object.assign(
        (selector: (s: typeof wsState) => unknown) => selector(wsState),
        { getState: () => wsState },
    )
    return { useWorkspacesStore }
})

import { useAuthStore } from '@/store/auth'
import { ImportTemplateDialog } from '../ImportTemplateDialog'

const FILE = {
    format: 'layout-template', formatVersion: 1, exportedAt: '2026-10-18T00:00:00Z',
    template: {
        name: 'Finance flow', description: 'Where money moves', category: 'finance',
        layers: [
            { id: 'src', name: 'Sources', entityTypes: ['Table'], order: 0 },
            { id: 'rep', name: 'Reports', entityTypes: ['Chart'], order: 1 },
        ],
    },
}

function renderDialog(existingNames: string[] = []) {
    const onImported = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={client}>
            <ImportTemplateDialog existingNames={existingNames} onClose={vi.fn()} onImported={onImported} />
        </QueryClientProvider>,
    )
    return { onImported }
}

function choose(content: unknown) {
    const file = new File([typeof content === 'string' ? content : JSON.stringify(content)], 'finance-flow.layout-template.json')
    fireEvent.change(screen.getByLabelText('Template file'), { target: { files: [file] } })
}

beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.setState({
        permissions: { global: [], ws: { ws_fin: ['workspace:datasource:read', 'workspace:view:create'] } },
    } as never)
})

describe('ImportTemplateDialog', () => {
    it('shows what the file holds, keeps a taken name apart, and creates it', async () => {
        service.create.mockResolvedValue({ id: 'tpl_new', name: 'Finance flow (imported)' })
        const { onImported } = renderDialog(['finance FLOW'])
        expect(screen.getByRole('button', { name: /import template/i })).toBeDisabled()

        choose(FILE)
        const name = await screen.findByDisplayValue('Finance flow (imported)')
        expect(name).toBeInTheDocument()
        expect(screen.getByText(/already has “Finance flow”/)).toBeInTheDocument()
        expect(screen.getByText('2 layers')).toBeInTheDocument()
        expect(screen.getByText(/Matches 1 of 2 layers in Finance — not there: Chart/)).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: /import template/i }))
        await waitFor(() => expect(service.create).toHaveBeenCalledWith(expect.objectContaining({
            name: 'Finance flow (imported)', description: 'Where money moves', category: 'finance',
            visibility: 'private', workspaceId: null,
        })))
        expect(service.create.mock.calls[0][0].layers.map((l: { name: string }) => l.name)).toEqual(['Sources', 'Reports'])
        await waitFor(() => expect(onImported).toHaveBeenCalledWith({ id: 'tpl_new', name: 'Finance flow (imported)' }))
        expect(notify).toHaveBeenCalledWith('success', 'Imported "Finance flow (imported)"')
    })

    it('says why a file is not a template, and imports nothing', async () => {
        renderDialog()
        choose({ format: 'view-bundle', formatVersion: 1 })
        expect(await screen.findByRole('alert')).toHaveTextContent("This isn't a layout template file")
        expect(screen.getByRole('button', { name: /import template/i })).toBeDisabled()
        expect(service.create).not.toHaveBeenCalled()
    })
})
