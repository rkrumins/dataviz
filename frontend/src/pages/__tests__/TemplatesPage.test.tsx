/**
 * Templates: the library people start Context Views from.
 *
 * Pins what each reader sees and may do: tabs that count and filter the whole
 * library, search over names, descriptions and layers, a menu that offers only
 * what the server's `access` allows, delete with a confirmation and an Undo,
 * "Use template" opening the view wizard with it, and the drawer on a link.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayoutTemplate } from '@/services/layoutTemplateService'

const { service, notify, openViewEditor } = vi.hoisted(() => ({
    service: {
        list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(),
        remove: vi.fn(), restore: vi.fn(), setHidden: vi.fn(),
        grants: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    },
    notify: vi.fn(),
    openViewEditor: vi.fn(),
}))

vi.mock('@/services/layoutTemplateService', () => ({ layoutTemplateService: service }))
vi.mock('@/services/viewApiService', () => ({ listViews: vi.fn().mockResolvedValue({ items: [], total: 0 }) }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/components/layout/viewEditorContext', () => ({ useViewEditorModal: () => ({ openViewEditor }) }))
vi.mock('@/lib/useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('@/components/ui/PersonChip', () => ({ PersonChip: ({ id }: { id: string }) => <span>{id}</span> }))
vi.mock('@/store/workspaces', () => {
    const state = { workspaces: [{ id: 'ws_fin', name: 'Finance' }] }
    const useWorkspacesStore = Object.assign(
        (selector: (s: typeof state) => unknown) => selector(state),
        { getState: () => state },
    )
    return { useWorkspacesStore }
})

import { useAuthStore } from '@/store/auth'
import { TemplatesPage } from '../TemplatesPage'

const NONE = { canEdit: false, canDelete: false, canShare: false, canHide: false }
const OWN = { canEdit: true, canDelete: true, canShare: true, canHide: false }

function t(id: string, name: string, over: Partial<LayoutTemplate> = {}): LayoutTemplate {
    return {
        id, name, description: '', category: null, visibility: 'private', builtIn: false, hidden: false,
        workspaceId: null, workspaceName: null, createdBy: 'usr_me', usageCount: 0, grantCount: 0, version: 1,
        createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
        layers: [{ id: `${id}-1`, name: 'Sources', entityTypes: ['Table'], order: 0, color: '#3b82f6' }],
        access: { via: 'owner', ...OWN },
        ...over,
    }
}

const LIBRARY = [
    t('tpl_medallion', 'Medallion', {
        builtIn: true, visibility: 'enterprise', createdBy: null, category: 'data-engineering',
        access: { via: 'builtin', ...NONE },
        layers: [
            { id: 'b', name: 'Bronze', entityTypes: [], order: 0 },
            { id: 's', name: 'Silver', entityTypes: [], order: 1 },
            { id: 'g', name: 'Gold', entityTypes: [], order: 2 },
        ],
    }),
    t('tpl_house', 'House style', { visibility: 'enterprise', createdBy: 'usr_lead', access: { via: 'organization', ...NONE } }),
    t('tpl_mine', 'My flow', { description: 'Where orders come from', usageCount: 3, grantCount: 2 }),
    t('tpl_team', 'Team flow', { createdBy: 'usr_ana', access: { via: 'grant', ...NONE, canEdit: true } }),
    t('tpl_ws', 'Finance flow', {
        visibility: 'workspace', workspaceId: 'ws_fin', workspaceName: 'Finance', createdBy: 'usr_ana',
        access: { via: 'workspace', ...NONE },
    }),
]

function renderAt(path = '/templates') {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={[path]}>
                <Routes>
                    <Route path="/templates" element={<TemplatesPage />} />
                    <Route path="/templates/:templateId" element={<TemplatesPage />} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

function card(name: string): HTMLElement {
    return screen.getByRole('button', { name }).closest('div.group') as HTMLElement
}

beforeEach(() => {
    vi.clearAllMocks()
    service.list.mockResolvedValue({ items: LIBRARY, total: LIBRARY.length })
    service.remove.mockResolvedValue(undefined)
    service.restore.mockResolvedValue(LIBRARY[2])
    useAuthStore.setState({ permissions: { global: [], ws: {} } } as never)
})

describe('TemplatesPage', () => {
    it('counts every collection and filters to one', async () => {
        renderAt()
        expect(await screen.findByRole('button', { name: 'My flow' })).toBeInTheDocument()
        const tabs = screen.getByRole('tablist', { name: 'Template collections' })
        expect(within(tabs).getByRole('tab', { name: /^All/ })).toHaveTextContent('5')
        expect(within(tabs).getByRole('tab', { name: /^Shared with me/ })).toHaveTextContent('1')

        fireEvent.click(within(tabs).getByRole('tab', { name: /^Mine/ }))
        expect(screen.getByRole('button', { name: 'My flow' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Medallion' })).not.toBeInTheDocument()

        fireEvent.click(within(tabs).getByRole('tab', { name: /^Workspace/ }))
        expect(screen.getByRole('button', { name: 'Finance flow' })).toBeInTheDocument()
        expect(screen.getAllByText('Finance').length).toBeGreaterThan(0)
    })

    it('searches names, descriptions and layer names, and offers a way back', async () => {
        renderAt()
        await screen.findByRole('button', { name: 'My flow' })
        const search = screen.getByRole('searchbox', { name: 'Search templates' })

        fireEvent.change(search, { target: { value: 'orders' } })
        expect(screen.getByRole('button', { name: 'My flow' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Team flow' })).not.toBeInTheDocument()

        fireEvent.change(search, { target: { value: 'silver' } })
        expect(screen.getByRole('button', { name: 'Medallion' })).toBeInTheDocument()

        fireEvent.change(search, { target: { value: 'nothing like it' } })
        expect(screen.getByText('Nothing matches "nothing like it"')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
        expect(screen.getByRole('button', { name: 'Team flow' })).toBeInTheDocument()
    })

    it('offers only what the server allows', async () => {
        renderAt()
        await screen.findByRole('button', { name: 'My flow' })

        fireEvent.click(within(card('Medallion')).getByRole('button', { name: 'More actions for Medallion' }))
        expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Duplicate'])
        fireEvent.keyDown(document, { key: 'Escape' })

        fireEvent.click(within(card('My flow')).getByRole('button', { name: 'More actions for My flow' }))
        expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Edit', 'Duplicate', 'Share', 'Delete'])
    })

    it('deletes after saying what happens, with an Undo that restores it', async () => {
        renderAt()
        await screen.findByRole('button', { name: 'My flow' })
        fireEvent.click(within(card('My flow')).getByRole('button', { name: 'More actions for My flow' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))

        const dialog = screen.getByRole('dialog')
        expect(dialog).toHaveTextContent('3 views built from it keep their layers')
        expect(dialog).toHaveTextContent('2 people and teams')
        fireEvent.click(within(dialog).getByRole('button', { name: /delete/i }))

        await waitFor(() => expect(service.remove).toHaveBeenCalledWith('tpl_mine'))
        await waitFor(() => expect(notify).toHaveBeenCalledWith(
            'success', 'Deleted "My flow"', expect.objectContaining({ label: 'Undo' }), expect.any(Number),
        ))
        const undo = notify.mock.calls.find(c => c[2]?.label === 'Undo')![2]
        undo.onClick()
        await waitFor(() => expect(service.restore).toHaveBeenCalledWith('tpl_mine'))
    })

    it('"Use template" starts a view from it', async () => {
        renderAt()
        await screen.findByRole('button', { name: 'Medallion' })
        fireEvent.click(within(card('Medallion')).getByRole('button', { name: /use template/i }))
        expect(openViewEditor).toHaveBeenCalledWith(undefined, { templateId: 'tpl_medallion' })
    })

    it('a link opens the template in the drawer, every layer listed', async () => {
        renderAt('/templates/tpl_medallion')
        const drawer = await screen.findByRole('dialog', { name: 'Template Medallion' })
        expect(within(drawer).getByText('3 layers')).toBeInTheDocument()
        for (const layer of ['Bronze', 'Silver', 'Gold']) {
            expect(within(drawer).getByText(layer)).toBeInTheDocument()
        }
        expect(within(drawer).getByText(/None yet/)).toBeInTheDocument()
    })

    it('lets a template manager hide a built-in for everyone', async () => {
        useAuthStore.setState({ permissions: { global: ['system:templates:manage'], ws: {} } } as never)
        service.list.mockResolvedValue({
            items: [{ ...LIBRARY[0], access: { via: 'builtin', ...NONE, canHide: true } }], total: 1,
        })
        service.setHidden.mockResolvedValue({ ...LIBRARY[0], hidden: true })
        renderAt()
        await screen.findByRole('button', { name: 'Medallion' })
        expect(screen.getByText('Show hidden built-ins')).toBeInTheDocument()
        fireEvent.click(within(card('Medallion')).getByRole('button', { name: 'More actions for Medallion' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Hide for everyone' }))
        await waitFor(() => expect(service.setHidden).toHaveBeenCalledWith('tpl_medallion', true))
    })

    it('an empty collection says what would be there and how to get some', async () => {
        service.list.mockResolvedValue({ items: [LIBRARY[0]], total: 1 })
        renderAt()
        await screen.findByRole('button', { name: 'Medallion' })
        fireEvent.click(screen.getByRole('tab', { name: /^Shared with me/ }))
        expect(screen.getByText('Nothing shared with you yet')).toBeInTheDocument()
        expect(screen.queryByText('Show hidden built-ins')).not.toBeInTheDocument()
    })
})
