/**
 * LibraryPopover's "This view" tab — the queries saved in the view's
 * library, for everyone who opens it: loaded with a click, removed (for
 * everyone, so after asking) by someone who can edit the view, and an
 * empty tab that says who can add to it.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const notify = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/notifications', () => ({
    useAppNotifications: () => ({ notify }),
}))

import type { SavedViewQuery } from '@/services/viewLibraryService'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useViewLibraryStore, type ViewLibraryState } from '@/store/viewLibraryStore'

import { LibraryPopover } from '../LibraryPopover'


/** The view the Recipes tab reads, through a provider that never answers. */
const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
function ViewProvider({ children }: { children: ReactNode }) {
    return (
        <ProviderOverride value={{ provider, isLoading: false, error: null, scopeKind: 'ready',
            workspaceId: 'ws', dataSourceId: null, providerReady: true, providerVersion: 1 } as never}>
            {children}
        </ProviderOverride>
    )
}


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
        open: true, onOpenChange: vi.fn(), recentQueries: [], viewId: 'view-1', onPickRecipe: vi.fn(),
        onLoadRecent: vi.fn(), onTogglePinRecent: vi.fn(), onRemoveRecent: vi.fn(),
        onSaveAs: vi.fn(), onLoadSaved: vi.fn(), activeDraft: false, ...over,
    }
    render(<LibraryPopover {...props}><button type="button">Library</button></LibraryPopover>, { wrapper: ViewProvider })
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
