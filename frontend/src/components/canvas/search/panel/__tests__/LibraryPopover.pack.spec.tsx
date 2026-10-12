/**
 * LibraryPopover's footer — the view's library (saved queries and display
 * rules) as a file: anyone who can open the view exports it; only someone
 * who can edit the view imports one, through the Property Manager's own
 * import dialog, which outlives the popover it was opened from.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const notify = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/notifications', () => ({
    useAppNotifications: () => ({ notify }),
}))

const exportViewLibrary = vi.hoisted(() => vi.fn())
const importViewLibrary = vi.hoisted(() => vi.fn())
vi.mock('@/services/viewLibraryService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/viewLibraryService')>()),
    exportViewLibrary, importViewLibrary,
}))

const saveLibraryFile = vi.hoisted(() => vi.fn())
const readLibraryFile = vi.hoisted(() => vi.fn())
vi.mock('@/components/canvas/property-manager/libraryFile', () => ({
    saveLibraryFile, readLibraryFile,
}))

import { useViewLibraryStore, type ViewLibraryState } from '@/store/viewLibraryStore'

import { LibraryPopover } from '../LibraryPopover'


function library(over: Partial<ViewLibraryState> = {}) {
    useViewLibraryStore.setState({
        viewId: 'view-1', branchId: null, status: 'ready', error: null, canEdit: false,
        savedQueries: [], ...over,
    })
}

/** ``onPanelKeyDown`` stands in for SearchMapPanel's handler, which the
 *  popover sits inside: it takes Enter to reveal a match on the canvas. */
function renderPopover(onPanelKeyDown = vi.fn()) {
    const props = {
        open: true, onOpenChange: vi.fn(), recentQueries: [], onSeedTemplate: vi.fn(),
        onLoadRecent: vi.fn(), onTogglePinRecent: vi.fn(), onRemoveRecent: vi.fn(),
        onSaveAs: vi.fn(), onLoadSaved: vi.fn(), activeDraft: false,
    }
    render(
        <div onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); onPanelKeyDown(e.key) }}>
            <LibraryPopover {...props}><button type="button">Library</button></LibraryPopover>
        </div>,
    )
    return props
}


beforeEach(() => {
    notify.mockReset()
    exportViewLibrary.mockReset()
    importViewLibrary.mockReset()
    saveLibraryFile.mockReset()
    readLibraryFile.mockReset()
})


describe('LibraryPopover — the library as a file', () => {
    it('offers someone who can edit the view both export and import', () => {
        library({ canEdit: true })
        renderPopover()
        expect(screen.getByRole('button', { name: /Export library/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Import library/ })).toBeInTheDocument()
    })

    it('offers someone who can only read the view the export alone', () => {
        library({ canEdit: false })
        renderPopover()
        expect(screen.getByRole('button', { name: /Export library/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Import library/ })).toBeNull()
    })

    it('exports the library of the view (or its draft) as a file', async () => {
        library({ branchId: 'br1' })
        const pack = { format: 'synodic.view-library', version: 1, displayRules: [], savedQueries: [] }
        exportViewLibrary.mockResolvedValueOnce(pack)
        renderPopover()
        await userEvent.setup().click(screen.getByRole('button', { name: /Export library/ }))
        expect(exportViewLibrary).toHaveBeenCalledWith('view-1', 'br1')
        await vi.waitFor(() => expect(saveLibraryFile).toHaveBeenCalledWith(pack))
    })

    it('says why an export failed', async () => {
        library()
        exportViewLibrary.mockRejectedValueOnce(new Error('Service Unavailable'))
        renderPopover()
        await userEvent.setup().click(screen.getByRole('button', { name: /Export library/ }))
        await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(
            'error', "Couldn't export the library — Service Unavailable"))
        expect(saveLibraryFile).not.toHaveBeenCalled()
    })

    it('opens the import dialog and puts the popover away', async () => {
        library({ canEdit: true })
        const props = renderPopover()
        await userEvent.setup().click(screen.getByRole('button', { name: /Import library/ }))
        expect(props.onOpenChange).toHaveBeenCalledWith(false)
        expect(screen.getByRole('dialog', { name: 'Import rules and saved queries' })).toBeInTheDocument()
    })

    it('imports a file and says how much it brought in', async () => {
        library({ canEdit: true })
        const pack = { format: 'synodic.view-library', version: 1, displayRules: [], savedQueries: [] }
        readLibraryFile.mockResolvedValueOnce(pack)
        importViewLibrary.mockImplementation((_view, _pack, { dryRun }: { dryRun: boolean }) => Promise.resolve({
            strategy: 'merge', dryRun, items: [], added: 2, skipped: 0, refused: 0, removed: 0,
        }))
        renderPopover()
        const user = userEvent.setup()
        await user.click(screen.getByRole('button', { name: /Import library/ }))
        await user.upload(screen.getByLabelText('Library file'),
            new File(['{}'], 'governance.library.json', { type: 'application/json' }))
        await user.click(await screen.findByRole('button', { name: 'Import 2 items' }))

        expect(importViewLibrary).toHaveBeenLastCalledWith('view-1', pack, { strategy: 'merge', dryRun: false, branchId: null })
        await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('success', 'Imported 2 items into this view'))
        expect(screen.queryByRole('dialog', { name: 'Import rules and saved queries' })).toBeNull()
    })

    it('keeps Enter on its own buttons, and in its dialog, from the search panel behind', async () => {
        library({ canEdit: true })
        exportViewLibrary.mockResolvedValueOnce({ format: 'synodic.view-library', version: 1 })
        const onPanelKeyDown = vi.fn()
        renderPopover(onPanelKeyDown)
        const user = userEvent.setup()

        screen.getByRole('button', { name: /Export library/ }).focus()
        await user.keyboard('{Enter}')
        expect(exportViewLibrary).toHaveBeenCalledTimes(1)

        screen.getByRole('button', { name: /Import library/ }).focus()
        await user.keyboard('{Enter}')
        const dialog = screen.getByRole('dialog', { name: 'Import rules and saved queries' })
        within(dialog).getAllByRole('button', { name: 'Cancel' })[0].focus()
        await user.keyboard('{Enter}')
        expect(screen.queryByRole('dialog', { name: 'Import rules and saved queries' })).toBeNull()

        expect(onPanelKeyDown).not.toHaveBeenCalled()
    })

    it('offers nothing to export before a view\'s library is loaded', () => {
        library({ viewId: null, canEdit: false })
        renderPopover()
        expect(screen.queryByRole('button', { name: /Export library/ })).toBeNull()
    })
})
