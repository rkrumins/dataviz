/**
 * LibraryPopover beyond the view it's open on: the queries saved on the
 * workspace's other views (and the user's own saved on other views) run
 * here with a click, copy into this view's library, make a display rule;
 * any saved query downloads as a file, and a file opens as a query.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const notify = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/notifications', () => ({
    useAppNotifications: () => ({ notify }),
}))
const listQueriesFromOtherViews = vi.hoisted(() => vi.fn())
vi.mock('@/services/viewLibraryService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/viewLibraryService')>()),
    listQueriesFromOtherViews,
}))
const saveQueryFile = vi.hoisted(() => vi.fn())
vi.mock('@/components/canvas/property-manager/libraryFile', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/canvas/property-manager/libraryFile')>()),
    saveQueryFile,
}))

import type { OtherViewQuery, SavedViewQuery } from '@/services/viewLibraryService'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore } from '@/store/searchStore'
import { useViewLibraryStore, type ViewLibraryState } from '@/store/viewLibraryStore'

import { LibraryPopover } from '../LibraryPopover'


const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
function ViewProvider({ children }: { children: ReactNode }) {
    return (
        <ProviderOverride value={{ provider, isLoading: false, error: null, scopeKind: 'ready',
            workspaceId: 'ws', dataSourceId: null, providerReady: true, providerVersion: 1 } as never}>
            {children}
        </ProviderOverride>
    )
}

const leaves: SavedViewQuery = {
    id: 'q-leaves', name: 'Leaves', description: 'Nothing inside them',
    predicate: { kind: 'related', axis: 'child', quantifier: 'none' },
}
const owned: SavedViewQuery = { id: 'q-owned', name: 'Owned', predicate: { kind: 'hasProperty', key: 'owner' } }
const OTHERS: OtherViewQuery[] = [
    { viewId: 'view-ops', viewName: 'Operations', sameSource: true, query: leaves },
    { viewId: 'view-fin', viewName: 'Finance', sameSource: false, query: owned },
]

function library(over: Partial<ViewLibraryState> = {}) {
    useViewLibraryStore.setState({
        viewId: 'view-1', branchId: null, status: 'ready', error: null, canEdit: false,
        savedQueries: [], ...over,
    })
}

function renderPopover(over: Partial<React.ComponentProps<typeof LibraryPopover>> = {}) {
    const props = {
        open: true, onOpenChange: vi.fn(), recentQueries: [], viewId: 'view-1', onPickRecipe: vi.fn(),
        onLoadRecent: vi.fn(), onTogglePinRecent: vi.fn(), onRemoveRecent: vi.fn(),
        onSaveAs: vi.fn(), onLoadSaved: vi.fn(), activeDraft: false, onMakeRule: vi.fn(), ...over,
    }
    render(<LibraryPopover {...props}><button type="button">Library</button></LibraryPopover>, { wrapper: ViewProvider })
    return props
}

const otherViews = async () => {
    await userEvent.setup().click(screen.getByRole('button', { name: 'Other views' }))
    await screen.findByText('Operations')
}


beforeEach(() => {
    notify.mockReset()
    saveQueryFile.mockReset()
    listQueriesFromOtherViews.mockReset().mockResolvedValue(OTHERS)
    useSearchStore.setState({ recentQueries: [] })
})


describe('LibraryPopover — other views', () => {
    it('lists them by view, says when one reads another data source, and runs one here', async () => {
        library()
        const props = renderPopover()
        await otherViews()
        expect(listQueriesFromOtherViews).toHaveBeenCalledWith('view-1', expect.any(AbortSignal))
        expect(screen.getByText('Finance')).toBeInTheDocument()
        expect(screen.getByText(/Another data source/)).toBeInTheDocument()
        await userEvent.setup().click(screen.getByTitle('Run it here: Leaves'))
        expect(props.onLoadSaved).toHaveBeenCalledWith(leaves)
        expect(props.onOpenChange).toHaveBeenCalledWith(false)
    })

    it('shows the user\'s own, saved on another view, first', async () => {
        library()
        useSearchStore.setState({ recentQueries: [
            { viewId: 'view-ops', predicate: owned.predicate, label: 'has:owner', timestamp: 7, pinned: true,
              source: 'mine', name: 'My owners' },
            // On this view: the Mine tab's, not repeated here.
            { viewId: 'view-1', predicate: owned.predicate, label: 'has:owner', timestamp: 8, pinned: true,
              source: 'mine', name: 'Here already' },
        ] })
        const props = renderPopover()
        await otherViews()
        expect(screen.getByText('Yours, saved on other views')).toBeInTheDocument()
        expect(screen.queryByText('Here already')).toBeNull()
        await userEvent.setup().click(screen.getByTitle('Run it here: My owners'))
        expect(props.onLoadSaved).toHaveBeenCalledWith(expect.objectContaining({
            name: 'My owners', predicate: owned.predicate }))
    })

    it('copies one into this view for someone who can edit it, under a new name when its own is taken', async () => {
        const saveQuery = vi.fn()
            .mockRejectedValueOnce(Object.assign(new Error('taken'), { status: 409 }))
            .mockResolvedValueOnce({ ...leaves, id: 'copy' })
        library({ canEdit: true, saveQuery } as Partial<ViewLibraryState>)
        renderPopover()
        await otherViews()
        await userEvent.setup().click(screen.getByRole('button', { name: 'Copy “Leaves” to this view' }))
        await waitFor(() => expect(saveQuery).toHaveBeenCalledTimes(2))
        expect(saveQuery).toHaveBeenNthCalledWith(1, expect.objectContaining({ name: 'Leaves' }))
        expect(saveQuery).toHaveBeenNthCalledWith(2, expect.objectContaining({ name: 'Leaves (from Operations)' }))
        expect(notify).toHaveBeenCalledWith('success', '“Leaves” is saved in this view now')
    })

    it('offers copies and rules only to someone who can edit the view; downloads to anyone', async () => {
        library()
        const props = renderPopover()
        await otherViews()
        expect(screen.queryByRole('button', { name: /Copy “Leaves”/ })).toBeNull()
        expect(screen.queryByRole('button', { name: /Make a display rule/ })).toBeNull()
        await userEvent.setup().click(screen.getByRole('button', { name: 'Download “Leaves”' }))
        expect(saveQueryFile).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'Leaves', predicate: leaves.predicate }),
            { viewId: 'view-ops', viewName: 'Operations' })
        expect(props.onMakeRule).not.toHaveBeenCalled()
    })

    it('makes a display rule of a query, from any tab', async () => {
        library({ canEdit: true, savedQueries: [owned] })
        const props = renderPopover()
        const user = userEvent.setup()
        await user.click(screen.getByRole('button', { name: 'Make a display rule of “Owned”' }))
        expect(props.onMakeRule).toHaveBeenCalledWith(owned.predicate, 'Owned')
        expect(props.onOpenChange).toHaveBeenCalledWith(false)
    })

    it('says so when nothing is saved elsewhere', async () => {
        listQueriesFromOtherViews.mockResolvedValue([])
        library()
        renderPopover()
        await userEvent.setup().click(screen.getByRole('button', { name: 'Other views' }))
        expect(await screen.findByText('Nothing saved on other views yet')).toBeInTheDocument()
    })
})


describe('LibraryPopover — a query from a file', () => {
    const file = (name: string, contents: unknown) =>
        new File([JSON.stringify(contents)], name, { type: 'application/json' })
    const chooseFile = async (f: File) => {
        const input = document.querySelector('input[type="file"]') as HTMLInputElement
        await userEvent.setup().upload(input, f)
    }

    it('runs the one query a file holds', async () => {
        library()
        const props = renderPopover()
        await chooseFile(file('leaves.library.json', {
            format: 'synodic.view-library', version: 1,
            savedQueries: [{ name: 'Leaves', predicate: leaves.predicate }], displayRules: [] }))
        await waitFor(() => expect(props.onLoadSaved).toHaveBeenCalledWith(expect.objectContaining({
            name: 'Leaves', predicate: leaves.predicate })))
    })

    it('reads a search\'s own JSON too, named after the file', async () => {
        library()
        const props = renderPopover()
        await chooseFile(file('big-tables.search.json', { predicate: owned.predicate, scope: { viewId: 'x' } }))
        await waitFor(() => expect(props.onLoadSaved).toHaveBeenCalledWith(expect.objectContaining({
            name: 'big-tables', predicate: owned.predicate })))
    })

    it('leaves a library of several to someone who can import it', async () => {
        library()
        const props = renderPopover()
        await chooseFile(file('lib.library.json', {
            format: 'synodic.view-library', version: 1, displayRules: [],
            savedQueries: [{ name: 'A', predicate: owned.predicate }, { name: 'B', predicate: leaves.predicate }] }))
        await waitFor(() => expect(notify).toHaveBeenCalledWith('warning', expect.stringMatching(/2 queries/)))
        expect(props.onLoadSaved).not.toHaveBeenCalled()
    })
})
