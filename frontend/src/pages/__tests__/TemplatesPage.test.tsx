/**
 * Templates: the library people start Context Views from.
 *
 * Pins what each reader sees and may do: tabs that count and filter the whole
 * library, search over names, descriptions and layers, a menu that offers only
 * what the server's `access` allows, delete with a confirmation and an Undo,
 * "Use template" opening the view wizard with it, and the drawer on a link —
 * plus the library's front shelves, favourites, how well each template fits a
 * workspace, requests to offer one to everyone, and a workspace's default.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayoutTemplate } from '@/services/layoutTemplateService'

const { service, notify, openViewEditor, workspaceUpdate, download, wsState } = vi.hoisted(() => ({
    service: {
        list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(),
        remove: vi.fn(), restore: vi.fn(), setHidden: vi.fn(), setFeatured: vi.fn(),
        favourite: vi.fn(), unfavourite: vi.fn(),
        requestPromotion: vi.fn(), withdrawPromotion: vi.fn(), promotionRequests: vi.fn(), answerPromotion: vi.fn(),
        grants: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    },
    notify: vi.fn(),
    openViewEditor: vi.fn(),
    workspaceUpdate: vi.fn(),
    download: vi.fn(),
    wsState: { workspaces: [] as unknown[], activeWorkspaceId: 'ws_fin', updateWorkspace: vi.fn() },
}))

vi.mock('@/services/layoutTemplateService', () => ({ layoutTemplateService: service }))
vi.mock('@/services/viewApiService', () => ({ listViews: vi.fn().mockResolvedValue({ items: [], total: 0 }) }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/components/layout/viewEditorContext', () => ({ useViewEditorModal: () => ({ openViewEditor }) }))
vi.mock('@/lib/useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('@/components/ui/PersonChip', () => ({ PersonChip: ({ id }: { id: string }) => <span>{id}</span> }))
vi.mock('@/store/workspaces', () => {
    const useWorkspacesStore = Object.assign(
        (selector: (s: typeof wsState) => unknown) => selector(wsState),
        { getState: () => wsState },
    )
    return { useWorkspacesStore }
})
vi.mock('@/services/workspaceService', () => ({ workspaceService: { update: workspaceUpdate } }))
vi.mock('@/services/importExportApiService', () => ({ triggerBrowserDownload: download }))
// The data any workspace declares: "table" — spelled its own way — and "Column".
vi.mock('@/hooks/useWorkspaceEntityTypes', () => ({
    useWorkspaceEntityTypes: (workspaceId?: string | null) => ({
        types: workspaceId ? ['table', 'Column'] : null, isLoading: false, isError: false,
    }),
}))

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

const FINANCE = { id: 'ws_fin', name: 'Finance', dataSources: [] as unknown[], defaultLayoutTemplateId: null }

beforeEach(() => {
    vi.clearAllMocks()
    service.list.mockResolvedValue({ items: LIBRARY, total: LIBRARY.length })
    service.remove.mockResolvedValue(undefined)
    service.restore.mockResolvedValue(LIBRARY[2])
    service.promotionRequests.mockResolvedValue([])
    wsState.workspaces = [FINANCE]
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
        expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Duplicate', 'Export as file'])
        fireEvent.keyDown(document, { key: 'Escape' })

        fireEvent.click(within(card('My flow')).getByRole('button', { name: 'More actions for My flow' }))
        expect(screen.getAllByRole('menuitem').map(i => i.textContent))
            .toEqual(['Edit', 'Duplicate', 'Export as file', 'Share', 'Delete'])
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

    it('a heart keeps a favorite one click away, before the server answers', async () => {
        let answer!: () => void
        service.favourite.mockReturnValue(new Promise<void>(resolve => { answer = resolve }))
        renderAt()
        await screen.findByRole('button', { name: 'My flow' })
        const favourites = () => screen.getByRole('tab', { name: /^Favorites/ })
        expect(favourites()).toHaveTextContent('0')

        fireEvent.click(within(card('My flow')).getByRole('button', { name: 'Favorite' }))
        await waitFor(() => expect(favourites()).toHaveTextContent('1'))
        expect(service.favourite).toHaveBeenCalledWith('tpl_mine')
        fireEvent.click(favourites())
        expect(screen.getByRole('button', { name: 'My flow' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Team flow' })).not.toBeInTheDocument()
        answer()
    })

    it('puts the heart back when the server refuses', async () => {
        service.favourite.mockRejectedValue(new Error('That template is gone'))
        renderAt()
        await screen.findByRole('button', { name: 'My flow' })
        fireEvent.click(within(card('My flow')).getByRole('button', { name: 'Favorite' }))
        await waitFor(() => expect(notify).toHaveBeenCalledWith('error', 'That template is gone'))
        expect(screen.getByRole('tab', { name: /^Favorites/ })).toHaveTextContent('0')
    })

    it('leads with what managers feature and what you used last, until you search', async () => {
        service.list.mockResolvedValue({
            items: [
                { ...LIBRARY[1], featured: true },
                { ...LIBRARY[2], lastUsedAt: '2026-10-17T10:00:00Z' },
                LIBRARY[3],
            ],
            total: 3,
        })
        renderAt()
        const featured = await screen.findByRole('region', { name: 'Featured' })
        expect(within(featured).getByRole('button', { name: 'House style' })).toBeInTheDocument()
        expect(within(featured).queryByRole('button', { name: 'Team flow' })).not.toBeInTheDocument()

        const recent = screen.getByRole('region', { name: 'Recently used' })
        expect(within(recent).getByText('My flow')).toBeInTheDocument()
        fireEvent.click(within(recent).getByRole('button', { name: /^Use/ }))
        expect(openViewEditor).toHaveBeenCalledWith(undefined, { templateId: 'tpl_mine' })

        fireEvent.change(screen.getByRole('searchbox', { name: 'Search templates' }), { target: { value: 'flow' } })
        expect(screen.queryByRole('region', { name: 'Featured' })).not.toBeInTheDocument()
        expect(screen.queryByRole('region', { name: 'Recently used' })).not.toBeInTheDocument()
    })

    it('shows how well each template fits a workspace, and sorts by it', async () => {
        wsState.workspaces = [{ ...FINANCE, dataSources: [{ id: 'ds_fin', isPrimary: true }] }]
        useAuthStore.setState({ permissions: { global: [], ws: { ws_fin: ['workspace:datasource:read'] } } } as never)
        service.list.mockResolvedValue({
            items: [
                t('tpl_half', 'Half fit', {
                    layers: [
                        { id: 'h1', name: 'Tables', entityTypes: ['Table'], order: 0 },
                        { id: 'h2', name: 'Charts', entityTypes: ['Chart'], order: 1 },
                    ],
                }),
                t('tpl_full', 'Full fit', { updatedAt: '2026-09-01T00:00:00Z' }),
            ],
            total: 2,
        })
        renderAt()
        await screen.findByRole('button', { name: 'Full fit' })
        const fitFor = screen.getByRole('combobox', { name: "Show how well templates fit a workspace's data" })
        expect(fitFor).toHaveValue('ws_fin')
        expect(within(card('Full fit')).getByRole('img', { name: '100% match' })).toBeInTheDocument()
        expect(within(card('Half fit')).getByRole('img', { name: '50% match' })).toBeInTheDocument()

        const names = () => screen.getAllByRole('button', { name: /^(Full|Half) fit$/ }).map(b => b.textContent)
        expect(names()).toEqual(['Half fit', 'Full fit'])
        fireEvent.change(screen.getByRole('combobox', { name: 'Sort templates' }), { target: { value: 'match' } })
        expect(names()).toEqual(['Full fit', 'Half fit'])

        fireEvent.change(fitFor, { target: { value: '' } })
        expect(screen.queryByRole('img', { name: /match/ })).not.toBeInTheDocument()
        expect(screen.getByRole('combobox', { name: 'Sort templates' })).toHaveValue('updated')
    })

    it('lets a template manager answer requests to offer a template to everyone', async () => {
        useAuthStore.setState({ permissions: { global: ['system:templates:manage'], ws: {} } } as never)
        const asked = t('tpl_pipeline', 'Pipeline flow', {
            createdBy: 'usr_ana',
            access: { via: 'request', ...NONE, canDecidePromotion: true },
            promotionRequest: { requestedBy: 'usr_ana', requestedAt: '2026-10-17T09:00:00Z', note: 'Three teams copy it' },
        })
        service.promotionRequests.mockResolvedValue([asked])
        service.answerPromotion.mockResolvedValue({ ...asked, visibility: 'enterprise', promotionRequest: null })
        renderAt('/templates?tab=requests')

        expect(await screen.findByText('Three teams copy it')).toBeInTheDocument()
        expect(screen.getByRole('tab', { name: /^Requests/ })).toHaveAttribute('aria-selected', 'true')
        expect(screen.getByRole('tab', { name: /^Requests/ })).toHaveTextContent('1')
        fireEvent.change(screen.getByRole('textbox', { name: 'A note for whoever asked' }), { target: { value: 'Welcome aboard' } })
        fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
        await waitFor(() => expect(service.answerPromotion).toHaveBeenCalledWith('tpl_pipeline', true, 'Welcome aboard'))
        expect(notify).toHaveBeenCalledWith('success', '"Pipeline flow" is now offered to everyone')
    })

    it('a manager declines from the drawer, which closes without calling the template missing', async () => {
        useAuthStore.setState({ permissions: { global: ['system:templates:manage'], ws: {} } } as never)
        const asked = t('tpl_pipeline', 'Pipeline flow', {
            createdBy: 'usr_ana',
            access: { via: 'request', ...NONE, canDecidePromotion: true },
            promotionRequest: { requestedBy: 'usr_ana', requestedAt: '2026-10-17T09:00:00Z' },
        })
        service.list.mockResolvedValue({ items: [...LIBRARY, asked], total: LIBRARY.length + 1 })
        service.answerPromotion.mockImplementation(async () => {
            service.list.mockResolvedValue({ items: LIBRARY, total: LIBRARY.length })  // no longer theirs to read
            return { ...asked, promotionRequest: null }
        })
        renderAt('/templates/tpl_pipeline')
        const drawer = await screen.findByRole('dialog', { name: 'Template Pipeline flow' })
        fireEvent.click(within(drawer).getByRole('button', { name: 'Decline' }))

        await waitFor(() => expect(service.answerPromotion).toHaveBeenCalledWith('tpl_pipeline', false, null))
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Template Pipeline flow' })).not.toBeInTheDocument())
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Pipeline flow' })).not.toBeInTheDocument())
        expect(notify).not.toHaveBeenCalledWith('warning', expect.anything())
    })

    it('shows the requests to template managers only', async () => {
        renderAt('/templates?tab=requests')
        await screen.findByRole('button', { name: 'My flow' })
        expect(screen.queryByRole('tab', { name: /^Requests/ })).not.toBeInTheDocument()
        expect(screen.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true')
        expect(service.promotionRequests).not.toHaveBeenCalled()
    })

    it("asks the template managers to offer a team's template to everyone, or withdraws", async () => {
        service.list.mockResolvedValue({
            items: [
                t('tpl_mine', 'My flow', { access: { via: 'owner', ...OWN, canRequestPromotion: true } }),
                t('tpl_asked', 'Asked flow', {
                    promotionRequest: { requestedBy: 'usr_me', requestedAt: '2026-10-17T09:00:00Z' },
                }),
            ],
            total: 2,
        })
        service.requestPromotion.mockResolvedValue({})
        service.withdrawPromotion.mockResolvedValue(undefined)
        renderAt()
        await screen.findByRole('button', { name: 'My flow' })

        fireEvent.click(within(card('My flow')).getByRole('button', { name: 'More actions for My flow' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Offer to everyone…' }))
        const dialog = screen.getByRole('dialog', { name: 'Offer My flow to everyone' })
        fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Every team copies it' } })
        fireEvent.click(within(dialog).getByRole('button', { name: 'Ask the template managers' }))
        await waitFor(() => expect(service.requestPromotion).toHaveBeenCalledWith('tpl_mine', 'Every team copies it'))

        expect(within(card('Asked flow')).getByText('Requested')).toBeInTheDocument()
        fireEvent.click(within(card('Asked flow')).getByRole('button', { name: 'More actions for Asked flow' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Withdraw the request' }))
        await waitFor(() => expect(service.withdrawPromotion).toHaveBeenCalledWith('tpl_asked'))
    })

    it('lets a template manager feature a template everyone can use', async () => {
        service.list.mockResolvedValue({
            items: [{ ...LIBRARY[1], access: { via: 'organization', ...NONE, canFeature: true } }], total: 1,
        })
        service.setFeatured.mockResolvedValue({ ...LIBRARY[1], featured: true })
        renderAt()
        await screen.findByRole('button', { name: 'House style' })
        fireEvent.click(within(card('House style')).getByRole('button', { name: 'More actions for House style' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Feature it' }))
        await waitFor(() => expect(service.setFeatured).toHaveBeenCalledWith('tpl_house', true))
        await waitFor(() => expect(notify).toHaveBeenCalledWith('success', `"House style" is featured at the top of everyone's library`))
    })

    it('makes a template the one new views in a workspace start from', async () => {
        useAuthStore.setState({ permissions: { global: [], ws: { ws_fin: ['workspace:admin'] } } } as never)
        workspaceUpdate.mockResolvedValue({ ...FINANCE, defaultLayoutTemplateId: 'tpl_house' })
        renderAt()
        await screen.findByRole('button', { name: 'House style' })

        // Every member must be able to use it: never a personal template.
        fireEvent.click(within(card('My flow')).getByRole('button', { name: 'More actions for My flow' }))
        expect(screen.queryByRole('menuitem', { name: 'Workspace default…' })).not.toBeInTheDocument()
        fireEvent.keyDown(document, { key: 'Escape' })

        fireEvent.click(within(card('House style')).getByRole('button', { name: 'More actions for House style' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Workspace default…' }))
        const dialog = screen.getByRole('dialog', { name: 'Workspace default: House style' })
        fireEvent.click(within(dialog).getByRole('switch', { name: 'Default in Finance' }))
        await waitFor(() => expect(workspaceUpdate).toHaveBeenCalledWith('ws_fin', { defaultLayoutTemplateId: 'tpl_house' }))
        expect(wsState.updateWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: 'ws_fin', defaultLayoutTemplateId: 'tpl_house' }))
    })

    it('exports a template as a file anyone can import', async () => {
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:tpl')
        renderAt()
        await screen.findByRole('button', { name: 'My flow' })
        fireEvent.click(within(card('My flow')).getByRole('button', { name: 'More actions for My flow' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Export as file' }))
        expect(download).toHaveBeenCalledWith('blob:tpl', 'my-flow.layout-template.json')
    })

    it('imports a template from a file and opens it', async () => {
        const created = t('tpl_imported', 'My flow (imported)')
        service.create.mockImplementation(async () => {
            service.list.mockResolvedValue({ items: [...LIBRARY, created], total: LIBRARY.length + 1 })
            return created
        })
        renderAt('/templates?import=1')
        await screen.findByRole('button', { name: 'My flow' })  // the library it is kept apart from
        const dialog = screen.getByRole('dialog', { name: 'Import a layout template' })
        const file = new File([JSON.stringify({
            format: 'layout-template', formatVersion: 1, exportedAt: '2026-10-18T00:00:00Z',
            template: { name: 'My flow', layers: [{ id: 'a', name: 'Sources', entityTypes: ['Table'], order: 0 }] },
        })], 'my-flow.layout-template.json')
        fireEvent.change(within(dialog).getByLabelText('Template file'), { target: { files: [file] } })
        expect(await within(dialog).findByDisplayValue('My flow (imported)')).toBeInTheDocument()
        fireEvent.click(within(dialog).getByRole('button', { name: /import template/i }))

        await waitFor(() => expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'My flow (imported)' })))
        expect(await screen.findByRole('dialog', { name: 'Template My flow (imported)' })).toBeInTheDocument()
        expect(screen.queryByRole('dialog', { name: 'Import a layout template' })).not.toBeInTheDocument()
    })

    it('answers the keyboard: search, new, open, use, favorite and move between cards', async () => {
        service.favourite.mockResolvedValue(undefined)
        renderAt()
        await screen.findByRole('button', { name: 'My flow' })

        fireEvent.keyDown(document, { key: '/' })
        expect(screen.getByRole('searchbox', { name: 'Search templates' })).toHaveFocus()
        fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search templates' }), { key: 'n' })  // typing, not a command
        expect(screen.queryByText('New layout template')).not.toBeInTheDocument()

        // From a card's own button, the arrows walk the cards.
        within(card('Medallion')).getByRole('button', { name: 'Medallion' }).focus()
        fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
        expect(card('House style')).toHaveFocus()
        fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
        expect(card('Medallion')).toHaveFocus()

        fireEvent.keyDown(document.activeElement!, { key: 'u' })
        expect(openViewEditor).toHaveBeenCalledWith(undefined, { templateId: 'tpl_medallion' })
        fireEvent.keyDown(document.activeElement!, { key: 'f' })
        expect(service.favourite).toHaveBeenCalledWith('tpl_medallion')
        fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
        expect(await screen.findByRole('dialog', { name: 'Template Medallion' })).toBeInTheDocument()
    })

    it('lists its shortcuts on "?", instead of opening Help', async () => {
        const help = vi.fn()
        window.addEventListener('keydown', help)
        renderAt()
        await screen.findByRole('button', { name: 'My flow' })
        fireEvent.keyDown(document, { key: '?' })
        const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' })
        expect(within(dialog).getByText('Move between templates')).toBeInTheDocument()
        expect(help).not.toHaveBeenCalled()
        window.removeEventListener('keydown', help)

        fireEvent.keyDown(document, { key: 'Escape' })
        fireEvent.keyDown(document, { key: 'n' })
        expect(await screen.findByText('New layout template')).toBeInTheDocument()
    })

    it('keeps the template in the drawer while it slides away', async () => {
        renderAt('/templates/tpl_medallion')
        const drawer = await screen.findByRole('dialog', { name: 'Template Medallion' })
        fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }))
        await waitFor(() => expect(drawer).toHaveAttribute('aria-hidden', 'true'))
        expect(within(drawer).getByText('Bronze')).toBeInTheDocument()
    })
})
