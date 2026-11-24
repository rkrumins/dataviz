/**
 * The drawer's tabs and actions at any width: every tab is a real tab in one strip that scrolls
 * sideways (it never squeezes or spills), the tab a link opens is brought into view, the arrow
 * keys move between tabs, the banners sit in the scrolling pane above the tab, and Watch and the
 * ⋯ menu stay together at the end of an action row that wraps.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../AboutDataSourceCard', () => ({ AboutDataSourceCard: () => <p>About card</p> }))
vi.mock('../DataSourceActivity', () => ({ DataSourceActivity: () => <p>History of the source</p> }))
vi.mock('../DataContactsCard', () => ({ DataContactsCard: () => <p>Contacts card</p> }))
vi.mock('@/features/discussions/useDiscussions', async (orig) => ({
    ...(await orig<typeof import('@/features/discussions/useDiscussions')>()),
    useSubjectSummary: () => ({ data: { open: 2 } }),
}))
vi.mock('@/components/insights/DataSourceProfile', () => ({ DataSourceProfile: () => null }))
vi.mock('@/components/ingestion/profiling/SourceProfiling', () => ({ SourceProfiling: () => null }))
vi.mock('../AggregationHistory', () => ({ AggregationHistory: () => null }))
vi.mock('@/features/versioning/components/DataSourceVersioningTab', () => ({
    DataSourceVersioningTab: () => <p>Version control panel</p>,
}))
vi.mock('../VocabAlignmentWarning', () => ({ VocabAlignmentWarning: () => <p>Vocabulary drift</p> }))
vi.mock('@/features/view-transfer/FinishImportingViewsBanner', () => ({ FinishImportingViewsBanner: () => null }))
vi.mock('@/features/data-source-transfer/DataSourceLifecycle', () => ({ DataSourceLifecycle: () => null, MovedFromChip: () => null }))
vi.mock('../DataSourceActionMenu', () => ({ DataSourceActionMenu: () => <button type="button">More actions</button> }))

import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { DataSourceDetailPanel } from '../DataSourceDetailPanel'
import type { DataSourceResponse } from '@/services/workspaceService'

const ds = {
    id: 'ds_gl', workspaceId: 'ws1', catalogItemId: 'cat_gl', label: 'General Ledger', accessLevel: 'read',
    isPrimary: true, isActive: true, identityProperty: 'urn', nameProperty: 'name',
} as DataSourceResponse

function Address() {
    const { search } = useLocation()
    return <p data-testid="address">{search}</p>
}

function renderAt(url: string) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={[url]}>
                <DataSourceDetailPanel ds={ds} wsId="ws1" isOpen viewCount={0} ontologies={[]}
                    onSaveEdit={vi.fn()} onReaggregate={vi.fn()} onPurge={vi.fn()} onSetPrimary={vi.fn()}
                    onSaveAggregationConfig={vi.fn()} onClose={vi.fn()} />
                <Address />
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

beforeEach(() => useFeaturesStore.setState({
    values: { ...DEFAULT_FEATURES, conversationsEnabled: true, dataSourceMetadataEnabled: true, versioningEnabled: true },
}))

describe('the data source drawer’s tabs', () => {
    it('lists every tab in one tablist that scrolls sideways, each keeping its size', () => {
        renderAt('/workspaces/ws1?ds=ds_gl')
        const strip = screen.getByRole('tablist', { name: 'About this data source' })
        expect(within(strip).getAllByRole('tab').map((t) => t.textContent?.replace(/\d+/g, '').trim()))
            .toEqual(['Overview', 'Processing', 'Trends', 'Views', 'Questions', 'Activity', 'Versioning'])
        expect(strip.className).toMatch(/overflow-x-auto/)
        for (const tab of within(strip).getAllByRole('tab')) {
            expect(tab.className).toMatch(/shrink-0/)
            expect(tab.className).toMatch(/whitespace-nowrap/)
            expect(tab.querySelector('svg')?.getAttribute('class')).toMatch(/shrink-0/)
        }
        expect(screen.getByRole('tab', { name: /Overview/ })).toHaveAttribute('aria-selected', 'true')
        expect(screen.getByRole('tab', { name: /Questions\s*2/ })).toBeInTheDocument()
    })

    it('brings the tab a link opens into view, and shows its panel', () => {
        const scrolled: number[] = []
        // The strip shows 300px of its tabs, and Versioning sits at 620–720px in it.
        const spies = [
            vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
                return this.getAttribute('role') === 'tablist' ? 300 : 0
            }),
            vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
                return this.textContent?.startsWith('Versioning') ? 620 : 0
            }),
            vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
                return this.textContent?.startsWith('Versioning') ? 100 : 0
            }),
            vi.spyOn(HTMLElement.prototype, 'scrollLeft', 'set').mockImplementation(function (this: HTMLElement, v: number) {
                if (this.getAttribute('role') === 'tablist') scrolled.push(v)
            }),
        ]
        try {
            renderAt('/workspaces/ws1?ds=ds_gl&dstab=versioning')
            expect(screen.getByRole('tab', { name: /Versioning/ })).toHaveAttribute('aria-selected', 'true')
            expect(screen.getByRole('tabpanel')).toHaveTextContent('Version control panel')
            expect(scrolled.at(-1)).toBe(720 - 300 + 24)       // its right edge, and a margin past the fade
        } finally {
            for (const spy of spies) spy.mockRestore()
        }
    })

    it('moves between tabs with the arrow keys, and keeps the tab in the address', async () => {
        renderAt('/workspaces/ws1?ds=ds_gl')
        const user = userEvent.setup()
        await user.click(screen.getByRole('tab', { name: /Overview/ }))
        await user.keyboard('{ArrowRight}')                      // Radix moves focus on a timer
        await waitFor(() => expect(screen.getByRole('tab', { name: /Processing/ })).toHaveAttribute('aria-selected', 'true'))
        expect(screen.getByTestId('address')).toHaveTextContent('dstab=aggregation')
        fireEvent.mouseDown(screen.getByRole('tab', { name: /Activity/ }))
        expect(screen.getByRole('tabpanel')).toHaveTextContent('History of the source')
    })

    it('puts the banners above the tab, in the pane that scrolls', () => {
        renderAt('/workspaces/ws1?ds=ds_gl')
        const banner = screen.getByText('Vocabulary drift')
        const pane = banner.closest('.overflow-y-auto')
        expect(pane).not.toBeNull()
        expect(pane).toContainElement(screen.getByRole('tabpanel'))
    })

    it('keeps Watch and the ⋯ menu together at the end of an action row that wraps', () => {
        renderAt('/workspaces/ws1?ds=ds_gl')
        const end = screen.getByTestId('ds-actions-end')
        expect(end).toContainElement(screen.getByRole('button', { name: /Watch/ }))
        expect(end.className).toMatch(/ml-auto/)
        expect(end.parentElement?.className).toMatch(/flex-wrap/)
    })
})
