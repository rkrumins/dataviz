/**
 * The Data tab's two newer sections: how well sources are described, and the
 * requests for data and for workspaces.
 */
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { DataTab } from '../DataTab'
import { DATA_LOCKED, DATA_PRIVILEGED } from '@/harness/analyticsFixtures'
import type { AnalyticsDataDoc } from '@/services/analyticsService'

beforeAll(() => {
    window.matchMedia = window.matchMedia ?? (((query: string) => ({
        matches: query.includes('min-width'), media: query, onchange: null,
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
        addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia)
})

function renderTab(data: AnalyticsDataDoc) {
    render(
        <MemoryRouter>
            <DataTab data={data} range={{ kind: 'preset', days: 14 }} isStale={false} />
        </MemoryRouter>,
    )
}

function section(heading: string): HTMLElement {
    const el = screen.getByRole('heading', { name: heading }).closest('section')
    if (!el) throw new Error(`no section ${heading}`)
    return el as HTMLElement
}

function tile(root: HTMLElement, label: string): HTMLElement {
    const el = within(root).getByText(label, { selector: 'p' }).closest('div.rounded-2xl')
    if (!el) throw new Error(`no tile ${label}`)
    return el as HTMLElement
}

describe('DataTab · details and requests', () => {
    it('says how many sources describe themselves, and how they are marked', () => {
        renderTab(DATA_PRIVILEGED)
        const details = section('How sources are described')

        // 41 of 58, 33 of 58, 26 of 58, 17 of 58.
        expect(within(tile(details, 'Described')).getByText('71%')).toBeInTheDocument()
        expect(within(tile(details, 'Described')).getByText('41 of 58 sources')).toBeInTheDocument()
        expect(within(tile(details, 'Tagged')).getByText('57%')).toBeInTheDocument()
        expect(within(tile(details, 'Named contacts')).getByText('45%')).toBeInTheDocument()
        expect(within(tile(details, 'Certified')).getByText('6 in review · 3 deprecated')).toBeInTheDocument()
        expect(within(details).getAllByText('Not marked')).toHaveLength(2)
        expect(within(details).getByText('Confidential')).toBeInTheDocument()
        expect(within(details).getByText('finance')).toBeInTheDocument()
        // The workspaces with the most sources, linked where the reader may open them.
        const table = within(details).getByRole('table')
        expect(within(table).getByRole('link', { name: 'Data Platform' })).toHaveAttribute('href', '/workspaces/ws1')
        expect(within(table).getByText('79%')).toBeInTheDocument()   // 27 of 34 described
    })

    it('counts the requests for data and for workspaces, most urgent first', () => {
        renderTab(DATA_PRIVILEGED)
        const requests = section('Requests')

        expect(within(tile(requests, 'Asked for')).getByText('9')).toBeInTheDocument()
        expect(within(tile(requests, 'Connected')).getByText('1 declined in the last 14 days')).toBeInTheDocument()
        const open = within(requests).getAllByText('Open now', { selector: 'p' })
        expect(within(open[0].closest('div.rounded-2xl') as HTMLElement)
            .getByText('2 this week · 3 this month · 2 no rush')).toBeInTheDocument()
        expect(within(tile(requests, 'Time to connect')).getByText('2 days')).toBeInTheDocument()
        expect(within(tile(requests, 'Submitted')).getByText('4')).toBeInTheDocument()
        expect(within(open[1].closest('div.rounded-2xl') as HTMLElement)
            .getByText('1 waiting on the person who asked')).toBeInTheDocument()
        expect(within(tile(requests, 'Time to a decision')).getByText('19h')).toBeInTheDocument()
    })

    it('hides requests and other workspaces from a reader who may not see them', () => {
        renderTab(DATA_LOCKED)

        expect(screen.getByText('Requests are hidden')).toBeInTheDocument()
        expect(screen.queryByText('Asked for')).toBeNull()
        const details = section('How sources are described')
        // Coverage is platform-wide; a tag used only elsewhere is not listed.
        expect(within(tile(details, 'Described')).getByText('71%')).toBeInTheDocument()
        expect(within(details).queryByText('marketing')).toBeNull()
        const table = within(details).getByRole('table')
        expect(within(table).getAllByText('Restricted workspace')).toHaveLength(2)
        expect(within(table).queryByRole('link', { name: 'Finance' })).toBeNull()
    })

    it('draws neither section from a document built before they existed', () => {
        renderTab({ ...DATA_PRIVILEGED, details: undefined, requests: undefined })
        expect(screen.queryByRole('heading', { name: 'How sources are described' })).toBeNull()
        expect(screen.queryByRole('heading', { name: 'Requests' })).toBeNull()
        expect(screen.queryByText('Requests are hidden')).toBeNull()
    })
})
