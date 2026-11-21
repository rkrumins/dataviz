/**
 * Your first steps in the Playground tick from what the reader really did: a graph, a view of
 * their own, a draft, a review, details saved, a change published (a review of theirs merged, or
 * their own tick). What a sample or an import made with the graph ticks nothing. A step once done
 * stays done; the list goes when everything is, or when it is hidden; each step says how.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceResponse } from '@/services/workspaceService'
import type { View } from '@/services/viewApiService'

const { getMyDrafts, getReviewInbox, getMetadata, getPlayground } = vi.hoisted(() => ({
    getMyDrafts: vi.fn(), getReviewInbox: vi.fn(), getMetadata: vi.fn(), getPlayground: vi.fn(),
}))
vi.mock('@/services/viewApiService', async (orig) => ({ ...await orig<typeof import('@/services/viewApiService')>(), getMyDrafts }))
vi.mock('@/services/versioningApiService', async (orig) => ({ ...await orig<typeof import('@/services/versioningApiService')>(), getReviewInbox }))
vi.mock('@/services/dataSourceMetadataService', async (orig) => {
    const actual = await orig<typeof import('@/services/dataSourceMetadataService')>()
    return { ...actual, dataSourceMetadataService: { ...actual.dataSourceMetadataService, get: getMetadata } }
})
vi.mock('@/services/playgroundService', () => ({ playgroundService: { get: getPlayground } }))

import { BuilderChecklist, STARTER_WINDOW_MS } from '../BuilderChecklist'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { useAuthStore } from '@/store/auth'

const BORN = '2026-11-20T10:00:00Z'
const at = (ms: number) => new Date(Date.parse(BORN) + ms).toISOString()
const SOON = at(30_000)
const LATER = at(STARTER_WINDOW_MS + 60_000)

const workspace = (dataSources: unknown[] = [{ id: 'ds_mine', createdBy: 'usr_me', createdAt: BORN }]) => ({
    id: 'ws_play', name: 'Playground', kind: 'playground', dataSources,
}) as unknown as WorkspaceResponse
const view = (id: string, createdAt: string, createdBy = 'usr_me') => ({ id, dataSourceId: 'ds_mine', createdBy, createdAt }) as unknown as View
const page = (items: unknown[]) => ({ items, total: items.length, queue: 'open', counts: {}, unread: {}, capped: false })

function renderList(props: { ws?: WorkspaceResponse; views?: View[] } = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter>
                <BuilderChecklist workspace={props.ws ?? workspace()} views={props.views ?? []} />
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

const step = (name: string) => screen.getByText(name).closest('li') as HTMLElement
const ring = () => screen.getByRole('progressbar', { name: 'First steps done' })

beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    useAuthStore.setState({ user: { id: 'usr_me' } as never })
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, playgroundEnabled: true, dataSourceMetadataEnabled: true } })
    getPlayground.mockResolvedValue({ graphsUsed: 1 })
    getMyDrafts.mockResolvedValue([])
    getReviewInbox.mockResolvedValue(page([]))
    getMetadata.mockResolvedValue({ dataSourceId: 'ds_mine', updatedBy: null, updatedAt: null })
})

describe('Your first steps', () => {
    it('lists the path, ticks a first graph, and says how to do each step', async () => {
        renderList()
        await waitFor(() => expect(step('Make a graph')).toHaveTextContent('— done'))
        expect(ring()).toHaveAttribute('aria-valuenow', '1')
        expect(ring()).toHaveAttribute('aria-valuemax', '6')
        expect(screen.getByText('1 of 6 done', { exact: false })).toBeInTheDocument()
        expect(within(step('Change something in a draft')).getByRole('link', { name: /How to/ }))
            .toHaveAttribute('href', '/guide/playground#edit-in-a-draft')
        expect(within(step('Publish a change')).getByRole('link', { name: /How to/ }))
            .toHaveAttribute('href', '/guide/playground#publish-your-own')
    })

    it('reads the reviews of the reader’s own, in this workspace', async () => {
        renderList()
        await waitFor(() => expect(getReviewInbox).toHaveBeenCalledWith('ws_play', expect.objectContaining({ queue: 'open', author: 'usr_me' })))
        expect(getReviewInbox).toHaveBeenCalledWith('ws_play', expect.objectContaining({ queue: 'done', author: 'usr_me' }))
    })

    it('ticks nothing a sample made with the graph', async () => {
        getMyDrafts.mockResolvedValue([{ draftId: 'b1', viewId: 'v1', workspaceId: 'ws_play', createdAt: SOON }])
        getReviewInbox.mockResolvedValue(page([{ prId: 'p1', createdAt: SOON, targetDataSourceId: 'ds_mine', status: 'open' }]))
        getMetadata.mockResolvedValue({ dataSourceId: 'ds_mine', updatedBy: { id: 'usr_me' }, updatedAt: SOON })
        renderList({ views: [view('v1', SOON)] })
        await waitFor(() => expect(getMetadata).toHaveBeenCalled())
        await waitFor(() => expect(getReviewInbox).toHaveBeenCalledTimes(2))
        for (const s of ['Make a view of your own', 'Change something in a draft', 'Send a change for review', 'Describe your data']) {
            expect(step(s)).not.toHaveTextContent('— done')
        }
    })

    it('ticks what the reader did themselves', async () => {
        getMyDrafts.mockResolvedValue([
            { draftId: 'b1', viewId: 'v2', workspaceId: 'ws_play', createdAt: LATER },
            { draftId: 'b9', viewId: 'v9', workspaceId: 'ws_elsewhere', createdAt: LATER },
        ])
        getReviewInbox.mockImplementation((_ws: string, p: { queue: string }) => Promise.resolve(p.queue === 'done'
            ? page([{ prId: 'p2', createdAt: LATER, targetDataSourceId: 'ds_mine', status: 'merged' }])
            : page([])))
        getMetadata.mockResolvedValue({ dataSourceId: 'ds_mine', updatedBy: { id: 'usr_me' }, updatedAt: LATER })
        renderList({ views: [view('v1', SOON), view('v2', LATER)] })
        // All six done: nothing left to show.
        await waitFor(() => expect(screen.queryByRole('region', { name: 'Your first steps' })).toBeNull())
    })

    it('takes the reader’s word for a change published straight away', async () => {
        renderList()
        await userEvent.click(await screen.findByRole('button', { name: 'I’ve published one' }))
        expect(step('Publish a change')).toHaveTextContent('— done')
        expect(screen.queryByRole('button', { name: 'I’ve published one' })).toBeNull()
    })

    it('keeps a step done once it was — a published draft leaves the drafts list', async () => {
        getMyDrafts.mockResolvedValue([{ draftId: 'b1', viewId: 'v2', workspaceId: 'ws_play', createdAt: LATER }])
        const { unmount } = renderList({ views: [view('v2', LATER)] })
        await waitFor(() => expect(step('Change something in a draft')).toHaveTextContent('— done'))
        unmount()
        getMyDrafts.mockResolvedValue([])
        renderList()
        expect(step('Change something in a draft')).toHaveTextContent('— done')
    })

    it('can be hidden, for good', async () => {
        const { unmount } = renderList()
        await userEvent.click(await screen.findByRole('button', { name: 'Hide your first steps' }))
        expect(screen.queryByRole('region', { name: 'Your first steps' })).toBeNull()
        unmount()
        renderList()
        expect(screen.queryByRole('region', { name: 'Your first steps' })).toBeNull()
    })

    it('leaves out describing data while data source details are off', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, playgroundEnabled: true, dataSourceMetadataEnabled: false } })
        renderList()
        expect(await screen.findByRole('region', { name: 'Your first steps' })).not.toHaveTextContent('Describe your data')
        expect(ring()).toHaveAttribute('aria-valuemax', '5')
        expect(getMetadata).not.toHaveBeenCalled()
    })
})
