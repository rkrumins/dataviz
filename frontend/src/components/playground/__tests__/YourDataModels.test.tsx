/**
 * Your data models: the reader's own and those others shared — draft or published, version, how
 * many graphs use each — each opened in the editor, the reader's own shared or not; the quota, with
 * New stopped at it; a new one made in four ways (blank, a copy, a layer file, from a file of
 * data), then opened in the editor; and refusals said in plain words.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlaygroundInfo, PlaygroundModel } from '@/services/playgroundService'

const { listModels, createLayer, shareLayer, list, notify } = vi.hoisted(() => ({
    listModels: vi.fn(), createLayer: vi.fn(), shareLayer: vi.fn(), list: vi.fn(), notify: vi.fn(),
}))
let info: Partial<PlaygroundInfo>
vi.mock('@/services/playgroundService', () => ({ playgroundService: { listModels, createLayer, shareLayer } }))
vi.mock('@/services/ontologyDefinitionService', () => ({ ontologyDefinitionService: { list } }))
vi.mock('@/hooks/usePlayground', () => ({ usePlayground: () => ({ data: info }) }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))

import { YourDataModels } from '../YourDataModels'

const model = (over: Partial<PlaygroundModel> & Pick<PlaygroundModel, 'id' | 'name' | 'kind'>): PlaygroundModel => ({
    description: null, version: 1, isPublished: true, entityTypeCount: 3, relationshipTypeCount: 2, usedBy: 0, ...over,
})
const MODELS = [
    model({ id: 'fin', name: 'Finance', kind: 'approved' }),
    model({ id: 'start', name: 'Starter', kind: 'starter' }),
    model({ id: 'mine', name: 'My things', kind: 'yours', version: 3, usedBy: 2 }),
    model({ id: 'draft', name: 'Half done', kind: 'yours', isPublished: false }),
    model({ id: 'theirs', name: 'Team map', kind: 'shared', usedBy: 1 }),
]

function Address() {
    return <p data-testid="address">{useLocation().search}</p>
}
function Editor() {
    return <p>editor {useParams().id}</p>
}

function renderPanel() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={['/workspaces/ws_play']}>
                <Routes>
                    <Route path="/workspaces/:wsId" element={<><YourDataModels /><Address /></>} />
                    <Route path="/schema/:id" element={<Editor />} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

const rows = async () => within(await screen.findByRole('list', { name: 'Your data models' })).getAllByRole('listitem')
const row = async (name: string) => (await rows()).find(r => r.textContent?.includes(name))!

async function openNew() {
    await userEvent.click(await screen.findByRole('button', { name: 'New data model' }))
    return screen.getByRole('dialog', { name: 'New data model' })
}

beforeEach(() => {
    vi.clearAllMocks()
    info = { workspaceId: 'ws_play', layerQuota: 20, layersUsed: 2 }
    listModels.mockResolvedValue(MODELS)
    list.mockResolvedValue([{ id: 'mine', ownerVisibility: 'workspace' }, { id: 'draft', ownerVisibility: 'private' }])
    createLayer.mockResolvedValue({ id: 'new1' })
    shareLayer.mockResolvedValue({})
})

describe('Your data models: the list', () => {
    it('lists the reader’s own and those shared, with status, version and use', async () => {
        renderPanel()
        const listed = await rows()
        expect(listed.map(r => r.querySelector('.truncate')?.textContent)).toEqual(['My things', 'Half done', 'Team map'])

        const mine = await row('My things')
        expect(mine).toHaveTextContent('Yours')
        expect(mine).toHaveTextContent('Published · v3 · used by 2 graphs')
        expect(within(mine).getByRole('link', { name: 'Open My things in the editor' })).toHaveAttribute('href', '/schema/mine')

        expect(await row('Half done')).toHaveTextContent('Draft · v1 · not used yet')
        const theirs = await row('Team map')
        expect(theirs).toHaveTextContent('Shared')
        expect(theirs).toHaveTextContent('used by 1 graph · read-only')
    })

    it('shares the reader’s own, and stops sharing — never one of someone else’s', async () => {
        renderPanel()
        const mine = within(await row('My things')).getByRole('switch', { name: 'Share My things with the Playground' })
        await waitFor(() => expect(mine).toBeChecked())
        await userEvent.click(mine)
        expect(shareLayer).toHaveBeenCalledWith('mine', false)

        await userEvent.click(within(await row('Half done')).getByRole('switch', { name: 'Share Half done with the Playground' }))
        expect(shareLayer).toHaveBeenCalledWith('draft', true)
        await waitFor(() => expect(notify).toHaveBeenCalledWith('success', expect.stringContaining('“Half done” is shared with the Playground')))

        expect(within(await row('Team map')).queryByRole('switch')).toBeNull()
    })

    it('says when there are none yet', async () => {
        listModels.mockResolvedValue(MODELS.filter(m => m.kind === 'approved'))
        renderPanel()
        expect(await screen.findByText(/No data models of your own yet/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'New data model' })).toBeEnabled()
    })

    it('shows the quota, and stops New at it, saying why', async () => {
        const { unmount } = renderPanel()
        expect(await screen.findByText('2 of 20 used')).toBeInTheDocument()
        unmount()

        info = { workspaceId: 'ws_play', layerQuota: 2, layersUsed: 2 }
        renderPanel()
        expect(await screen.findByText('2 of 2 used')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'New data model' })).toBeDisabled()
        expect(screen.getByText(/You’ve made all 2 data models you may keep/)).toBeInTheDocument()
    })
})

describe('Your data models: four ways to make one', () => {
    it('blank: a name, then it opens in the editor', async () => {
        renderPanel()
        const dialog = await openNew()
        const create = within(dialog).getByRole('button', { name: 'Create and open' })
        expect(create).toBeDisabled()
        await userEvent.type(within(dialog).getByLabelText('Name'), 'Shop floor')
        await userEvent.click(create)
        expect(createLayer).toHaveBeenCalledWith({ name: 'Shop floor', from: { blank: true } })
        expect(await screen.findByText('editor new1')).toBeInTheDocument()
    })

    it('copy: one the reader may build on, not one of their own', async () => {
        renderPanel()
        const dialog = await openNew()
        await userEvent.click(within(dialog).getByRole('radio', { name: /Copy one you can use/ }))
        const picks = within(dialog).getByRole('group', { name: 'Copy which?' })
        expect(within(picks).getAllByRole('radio').map(r => (r as HTMLInputElement).value)).toEqual(['fin', 'start', 'theirs'])
        expect(within(dialog).getByRole('button', { name: 'Create and open' })).toBeDisabled()
        await userEvent.click(within(picks).getByRole('radio', { name: /Finance/ }))
        expect(within(dialog).getByLabelText('Name')).toHaveValue('Finance (copy)')
        await userEvent.click(within(dialog).getByRole('button', { name: 'Create and open' }))
        expect(createLayer).toHaveBeenCalledWith({ name: 'Finance (copy)', from: { cloneOf: 'fin' } })
        expect(await screen.findByText('editor new1')).toBeInTheDocument()
    })

    it('import: a layer file exported from Semantic Layers, read here and sent as it is', async () => {
        renderPanel()
        const dialog = await openNew()
        await userEvent.click(within(dialog).getByRole('radio', { name: /Import a layer file/ }))
        const input = within(dialog).getByLabelText('Choose a layer file')

        await userEvent.upload(input, new File(['[1, 2]'], 'list.json', { type: 'application/json' }))
        expect(await within(dialog).findByRole('alert')).toHaveTextContent('list.json isn’t a layer file exported from Semantic Layers.')
        await userEvent.upload(input, new File(['{oops'], 'bad.json', { type: 'application/json' }))
        expect(await within(dialog).findByText('bad.json couldn’t be read as JSON.')).toBeInTheDocument()
        expect(within(dialog).getByRole('button', { name: 'Create and open' })).toBeDisabled()

        const layer = { name: 'Plant', entityTypeDefinitions: { machine: { name: 'Machine' } }, relationshipTypeDefinitions: {} }
        await userEvent.upload(input, new File([JSON.stringify(layer)], 'Plant_v2.json', { type: 'application/json' }))
        expect(await within(dialog).findByText('Plant_v2.json')).toBeInTheDocument()
        expect(within(dialog).getByLabelText('Name')).toHaveValue('Plant')
        await userEvent.click(within(dialog).getByRole('button', { name: 'Create and open' }))
        expect(createLayer).toHaveBeenCalledWith({ name: 'Plant', from: { layer } })
    })

    it('from a file of data: opens Bring your own data', async () => {
        renderPanel()
        const dialog = await openNew()
        await userEvent.click(within(dialog).getByRole('radio', { name: /From a file of your data/ }))
        expect(within(dialog).queryByLabelText('Name')).toBeNull()
        await userEvent.click(within(dialog).getByRole('button', { name: 'Bring your own data' }))
        expect(screen.getByTestId('address')).toHaveTextContent('?start=import')
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(createLayer).not.toHaveBeenCalled()
    })

    it.each([
        ['layer_quota', 'You’ve made all the data models you may keep — delete one you’re done with, then try again.'],
        ['feature_disabled', 'Data models of your own are turned off right now.'],
        ['playground_not_member', 'Join the Playground first — open it from the sidebar — then try again.'],
    ])('says a %s refusal in plain words, and stays open', async (type, words) => {
        createLayer.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403, detail: { type, message: 'x' } }))
        renderPanel()
        const dialog = await openNew()
        await userEvent.type(within(dialog).getByLabelText('Name'), 'Shop floor')
        await userEvent.click(within(dialog).getByRole('button', { name: 'Create and open' }))
        expect(await within(dialog).findByRole('alert')).toHaveTextContent(words)
        expect(within(dialog).getByRole('button', { name: 'Create and open' })).toBeEnabled()
    })
})
