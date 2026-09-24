/**
 * The card menu's visibility switch.
 *
 * It used to fire the PUT, say nothing, and call an optional callback
 * that no parent supplied — so the request succeeded, the card kept
 * showing the old tier, and the only way to see the change was a full
 * page reload. It looked exactly like a no-op.
 *
 * These tests pin the three things that made it feel broken: the
 * confirmation names the new audience, the settled value is handed back
 * to whoever owns the list, and the one tier that cannot be set from a
 * menu routes to the dialog that explains it instead of firing a 403.
 *
 * Also: Versions, Export and Update from file are a preview behind one admin switch.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const notify = vi.fn()
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/services/viewApiService', () => ({ updateViewVisibility: vi.fn() }))
vi.mock('@/components/views/ViewActivityDrawer', () => ({ ViewActivityDrawer: () => null }))
vi.mock('@/store/branding', () => ({ useBrand: () => ({ appName: 'TestBrand' }) }))
vi.mock('@/features/view-versions/ViewVersionsDrawer', () => ({ ViewVersionsDrawer: () => null }))
vi.mock('@/features/view-transfer/ExportViewDialog', () => ({ ExportViewDialog: () => null }))

const gate = {
    canPublish: true,
    canRequestPublish: false,
    restrictedSource: false,
    blockedBy: null as string | null,
    enterpriseAvailable: true,
}
vi.mock('@/hooks/usePublishGate', () => ({ usePublishGate: () => gate }))

import { updateViewVisibility } from '@/services/viewApiService'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { ViewEditorContext } from '@/components/layout/viewEditorContext'
import { ViewCardOverflowMenu } from '../ViewCardOverflowMenu'

const mockSetVisibility = vi.mocked(updateViewVisibility)

function renderMenu(over: Record<string, unknown> = {}) {
    const props = {
        viewId: 'view_1',
        viewName: 'Quarterly lineage',
        visibility: 'private' as const,
        workspaceId: 'ws_1',
        onDelete: vi.fn(),
        onShare: vi.fn(),
        onVisibilityChange: vi.fn(),
        ...over,
    }
    render(<ViewCardOverflowMenu {...props} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Change Visibility'))
    return props
}

beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(gate, {
        canPublish: true, canRequestPublish: false, restrictedSource: false,
        blockedBy: null, enterpriseAvailable: true,
    })
    mockSetVisibility.mockResolvedValue({} as never)
})

describe('after the change lands', () => {
    it('hands the settled tier back so the card can stop lying', async () => {
        const props = renderMenu()
        fireEvent.click(screen.getByText('Workspace'))
        await waitFor(() =>
            expect(props.onVisibilityChange).toHaveBeenCalledWith('workspace'))
    })

    it('confirms with the new audience, not the word "updated"', async () => {
        renderMenu()
        fireEvent.click(screen.getByText('Enterprise'))
        await waitFor(() => expect(notify).toHaveBeenCalled())
        const [level, message] = notify.mock.calls[0]
        expect(level).toBe('success')
        expect(message).toMatch(/Quarterly lineage/)
        expect(message).toMatch(/anyone signed in to TestBrand/i)
    })

    it('does not call the server for the tier already set', () => {
        renderMenu({ visibility: 'workspace' })
        fireEvent.click(screen.getByText('Workspace'))
        expect(mockSetVisibility).not.toHaveBeenCalled()
    })
})

describe('guidance in the menu', () => {
    it('explains each tier instead of listing three bare words', () => {
        renderMenu()
        expect(screen.getByText(/anyone signed in to TestBrand/i)).toBeTruthy()
        expect(screen.getByText(/only you/i)).toBeTruthy()
    })

    it('marks which one is currently in force', () => {
        renderMenu({ visibility: 'workspace' })
        expect(screen.getByText('Current')).toBeTruthy()
    })
})

describe('the tier that needs approval', () => {
    beforeEach(() => {
        Object.assign(gate, { canPublish: false, canRequestPublish: true, blockedBy: 'workspace' })
    })

    it('routes to the Share dialog rather than firing a doomed request', async () => {
        const props = renderMenu()
        fireEvent.click(screen.getByText('Enterprise'))
        await waitFor(() => expect(props.onShare).toHaveBeenCalled())
        // A menu is the wrong place to ask for publication: the request
        // carries a note, and the dialog is where the audience panel
        // explains what publishing exposes.
        expect(mockSetVisibility).not.toHaveBeenCalled()
    })

    it('says so on the tile, and says who decides', () => {
        renderMenu()
        // Both the badge and the reason under it — the badge alone would
        // leave "approval from whom?" unanswered.
        expect(screen.getByText('Needs approval')).toBeTruthy()
        expect(screen.getByText(/ask a workspace admin/i)).toBeTruthy()
    })
})

describe('when the deployment has withdrawn the tier', () => {
    it('does not offer it at all', () => {
        Object.assign(gate, {
            canPublish: false, canRequestPublish: false,
            blockedBy: 'platform', enterpriseAvailable: false,
        })
        renderMenu()
        expect(screen.queryByText('Enterprise')).toBeNull()
    })
})

describe('versions, export and import: a preview behind one admin switch', () => {
    function openMenu() {
        const openViewEditor = vi.fn()
        render(
            <ViewEditorContext.Provider value={{ openViewEditor, closeViewEditor: vi.fn() }}>
                <ViewCardOverflowMenu
                    viewId="view_1" viewName="Quarterly lineage" visibility="private" workspaceId="ws_1"
                    onDelete={vi.fn()} onShare={vi.fn()} onEditLayout={vi.fn()}
                />
            </ViewEditorContext.Provider>,
        )
        fireEvent.click(screen.getByRole('button'))
    }
    const set = (values: Record<string, unknown>) =>
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, ...values } })
    afterEach(() => set({}))

    it('offers none of them while the preview is off, whatever the direction switches say', () => {
        set({ viewPortabilityEnabled: false, viewExportEnabled: true, viewImportEnabled: true })
        openMenu()
        expect(screen.getByText('Activity')).toBeTruthy()
        expect(screen.queryByText('Versions')).toBeNull()
        expect(screen.queryByText('Export…')).toBeNull()
        expect(screen.queryByText('Update from file…')).toBeNull()
    })

    it('offers them with the preview on, each direction following its own switch', () => {
        set({ viewPortabilityEnabled: true, viewExportEnabled: false, viewImportEnabled: true })
        openMenu()
        expect(screen.getByText('Versions')).toBeTruthy()
        expect(screen.queryByText('Export…')).toBeNull()
        expect(screen.getByText('Update from file…')).toBeTruthy()
    })
})
