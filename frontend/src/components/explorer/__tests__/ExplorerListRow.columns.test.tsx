/**
 * A list row has exactly the header's columns. The usage counters and the
 * "new to you" note used to be cells of their own, so whenever usage was known
 * every column after Scope sat under the wrong header.
 */
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { View } from '@/services/viewApiService'
import { ExplorerListRow } from '../ExplorerListRow'
import { ExplorerListHeader } from '../ExplorerListHeader'

const view = {
    id: 'v1', name: 'Revenue lineage', viewType: 'graph', workspaceId: 'ws1', workspaceName: 'Sales',
    dataSourceId: 'ds1', dataSourceName: 'Ledger', visibility: 'workspace', isFavourited: false, favouriteCount: 2,
    tags: [], config: {}, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z',
    createdBy: 'usr_ada', createdByName: 'Ada',
} as unknown as View
const usage = { viewId: 'v1', opens: 40, uniqueViewers: 6, lastOpenedAt: '2026-11-19T00:00:00Z', trend: [1, 2], windowDays: 30 }

function cells(withCheckbox: boolean) {
    render(
        <QueryClientProvider client={new QueryClient()}>
            <MemoryRouter>
                <ExplorerListHeader sort="recently-modified" onSortChange={() => {}} withCheckbox={withCheckbox} />
                <ExplorerListRow view={view} usage={usage as never} onToggleFavourite={() => {}} onShare={() => {}}
                    onToggleSelect={withCheckbox ? () => {} : undefined} />
            </MemoryRouter>
        </QueryClientProvider>,
    )
    const header = screen.getByText('Scope').parentElement!
    const row = screen.getByText('Revenue lineage').closest('[class*="grid-cols-"]')!
    return { header: header.children.length, row: row.children.length }
}

describe('ExplorerListRow', () => {
    it('has exactly the header’s columns when usage is known', () => {
        const { header, row } = cells(false)
        expect(row).toBe(header)
    })

    it('and with the selection column too', () => {
        const { header, row } = cells(true)
        expect(row).toBe(header)
    })
})
