/**
 * The preview panel has to fit a 1080px screen without scrolling past its own
 * buttons.
 *
 * It got there by degrees, and each step is pinned here because each was a
 * separate thing saying the same fact twice:
 *
 *  * the workspace / data source / provider PILLS said what the "What this view
 *    is built on" chain says immediately below them, in less detail;
 *  * "Context View" appeared three times in the top third — the header pill, a
 *    View Type card, and a Layout card holding the identical word beside it;
 *  * Created and Updated printed the same instant under two different words on
 *    any view nobody had edited.
 *
 * What is left is the last of it: four timestamp rows, about 150px, the
 * least-read block on the panel. They fold. WHO MADE IT does not — that is the
 * question the panel is opened for most often, and folding the whole block away
 * took it with the dates.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/useContentInsights', () => ({ useViewUsage: () => ({ data: undefined }) }))
vi.mock('@/components/views/ViewBuiltOn', () => ({ ViewBuiltOn: () => null }))
vi.mock('@/components/views/EditDetailsPanel', () => ({ EditDetailsPanel: () => null }))
vi.mock('@/components/views/ViewActivityDrawer', () => ({ ViewActivityDrawer: () => null }))

import { ExplorerPreviewDrawer } from '../ExplorerPreviewDrawer'
import type { View } from '@/services/viewApiService'

const view = (over: Partial<View> = {}): View => ({
    id: 'v1',
    name: 'Impact Analysis',
    viewType: 'reference',
    workspaceId: 'ws-1',
    workspaceName: 'Writes',
    dataSourceId: 'ds-1',
    dataSourceName: 'Nexus Lineage',
    visibility: 'private',
    tags: [],
    createdByName: 'System Admin',
    createdByEmail: 'admin@nexuslineage.local',
    createdAt: '2026-07-11T01:10:00Z',
    updatedAt: '2026-08-31T00:22:00Z',
    updatedByName: 'System Admin',
    ...over,
} as View)

function renderDrawer(v: View = view()) {
    return render(
        <MemoryRouter>
        <ExplorerPreviewDrawer
            view={v}
            isOpen
            onClose={() => {}}
            onShare={() => {}}
        />
        </MemoryRouter>,
    )
}

beforeEach(() => vi.clearAllMocks())

describe('the preview panel’s Details block', () => {
    it('shows WHO MADE IT without asking', async () => {
        renderDrawer()
        expect(await screen.findByText('System Admin')).toBeInTheDocument()
        expect(screen.getByText('admin@nexuslineage.local')).toBeInTheDocument()
    })

    it('folds the timestamps away behind one disclosure', async () => {
        renderDrawer()
        await screen.findByText('System Admin')
        const disclosure = screen.getByText('See all details').closest('details')
        expect(disclosure, 'the dates live in a disclosure').toBeTruthy()
        expect(disclosure).not.toHaveAttribute('open')
        // The rows are in the DOM (a native <details> keeps them) but closed,
        // which is what buys back the height. Assert the CONTAINMENT rather
        // than visibility, because jsdom does not apply the UA stylesheet that
        // hides a closed details' children.
        expect(disclosure!.textContent).toContain('Created')
        expect(disclosure!.textContent).toContain('Updated')
    })

    it('keeps the author OUT of the fold', async () => {
        // The regression this exists to stop: folding the whole Details block
        // hid the one fact worth a line unconditionally.
        renderDrawer()
        await screen.findByText('System Admin')
        const disclosure = screen.getByText('See all details').closest('details')!
        expect(disclosure.textContent).not.toContain('admin@nexuslineage.local')
    })

    it('says when it was last updated on the closed summary, so the fold costs nothing', async () => {
        renderDrawer()
        const summary = (await screen.findByText('See all details')).closest('summary')!
        expect(summary.textContent).toMatch(/updated/i)
    })

    it('opens on a click, and the dates are all there', async () => {
        const u = userEvent.setup()
        renderDrawer()
        await u.click(await screen.findByText('See all details'))
        const disclosure = screen.getByText('See all details').closest('details')!
        expect(disclosure).toHaveAttribute('open')
        expect(screen.getByText('Created')).toBeInTheDocument()
        expect(screen.getByText('Data Updated')).toBeInTheDocument()
    })

    it('does not print the same instant twice under two words', async () => {
        // Created and Updated are identical on any view nobody has edited.
        const same = '2026-07-11T01:10:00Z'
        renderDrawer(view({ createdAt: same, updatedAt: same }))
        await screen.findByText('System Admin')
        expect(screen.getByText('Created')).toBeInTheDocument()
        expect(screen.queryByText('Updated')).toBeNull()
    })

    it('does not repeat the chain’s facts as pills above it', async () => {
        // The pills said workspace / data source / provider, and the chain
        // below said all three again with more detail. Only visibility — the
        // one fact the chain does not carry — stays, and it moved into the
        // header beside the type.
        renderDrawer()
        await screen.findByText('System Admin')
        expect(screen.queryByText('Nexus Lineage')).toBeNull()
        expect(screen.getAllByText('Private').length).toBe(1)
    })
})
