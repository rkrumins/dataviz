/**
 * LibraryPopover's "This view" tab — the queries saved in the view's
 * library, for everyone who opens it: loaded with a click, removed (for
 * everyone, so after asking) by someone who can edit the view, and an
 * empty tab that says who can add to it.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const notify = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/notifications', () => ({
    useAppNotifications: () => ({ notify }),
}))

import type { SavedViewQuery } from '@/services/viewLibraryService'
import { useViewLibraryStore, type ViewLibraryState } from '@/store/viewLibraryStore'

import { LibraryPopover } from '../LibraryPopover'


const tables: SavedViewQuery = {
    id: 'q1', name: 'Tables', description: 'Every table in the view',
    predicate: { kind: 'entityType', op: 'in', values: ['table'] },
}

function library(over: Partial<ViewLibraryState> = {}) {
    useViewLibraryStore.setState({
        viewId: 'view-1', branchId: null, status: 'ready', error: null, canEdit: false,
        savedQueries: [tables], removeQuery: vi.fn(async () => {}), ...over,
    })
}

function renderPopover(over: Partial<React.ComponentProps<typeof LibraryPopover>> = {}) {
    const props = {
        open: true, onOpenChange: vi.fn(), recentQueries: [], onSeedTemplate: vi.fn(),
        onLoadRecent: vi.fn(), onTogglePinRecent: vi.fn(), onRemoveRecent: vi.fn(),
        onSaveAs: vi.fn(), onLoadSaved: vi.fn(), activeDraft: false, ...over,
    }
    render(<LibraryPopover {...props}><button type="button">Library</button></LibraryPopover>)
    return props
}


beforeEach(() => notify.mockReset())


describe('LibraryPopover — This view', () => {
    it('opens on the view\'s saved queries and loads one', async () => {
        library()
        const props = renderPopover()
        expect(screen.getByRole('button', { name: /This view/ })).toHaveAttribute('aria-pressed', 'true')
        expect(screen.getByText('Every table in the view')).toBeInTheDocument()
        await userEvent.setup().click(screen.getByTitle('Load: Tables'))
        expect(props.onLoadSaved).toHaveBeenCalledWith(tables)
        expect(props.onOpenChange).toHaveBeenCalledWith(false)
    })

    it('lets someone who can edit the view remove one for everyone, after asking', async () => {
        const removeQuery = vi.fn(async () => {})
        library({ canEdit: true, removeQuery })
        renderPopover()
        const user = userEvent.setup()
        await user.click(screen.getByRole('button', { name: 'Remove “Tables” from this view' }))
        expect(removeQuery).not.toHaveBeenCalled()
        await user.click(screen.getByRole('button', { name: 'Remove for everyone' }))
        expect(removeQuery).toHaveBeenCalledWith('q1')
    })

    it('offers no removal to someone who can\'t edit the view', () => {
        library()
        renderPopover()
        expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull()
    })

    it('says who can add queries when the view has none', async () => {
        library({ savedQueries: [] })
        renderPopover()
        await userEvent.setup().click(screen.getByRole('button', { name: /This view/ }))
        expect(screen.getByText(/People who can edit this view can save queries here/)).toBeInTheDocument()
    })
})
