/**
 * The Collaboration tab: what it counts, where its rankings lead, what a
 * redacted reader is not shown, and what it says when there is nothing.
 */
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { CollaborationTab } from '../CollaborationTab'
import { COLLAB_EMPTY, COLLAB_PRIVILEGED, COLLAB_STRICT } from '@/harness/analyticsFixtures'
import type { AnalyticsCollaborationDoc } from '@/services/analyticsService'
import { percent, signedPercent } from '@/lib/formatMetric'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

beforeAll(() => {
    window.matchMedia = window.matchMedia ?? (((query: string) => ({
        matches: query.includes('min-width'), media: query, onchange: null,
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
        addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia)
})

const RANGE = { kind: 'preset' as const, days: 14 }

function renderTab(data: AnalyticsCollaborationDoc, { conversations = true, onWorkspaceClick = vi.fn() } = {}) {
    act(() => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: conversations } })
    })
    render(
        <MemoryRouter>
            <CollaborationTab data={data} range={RANGE} isStale={false} onWorkspaceClick={onWorkspaceClick} />
        </MemoryRouter>,
    )
    return { onWorkspaceClick }
}

/** The tile whose label is `label`. */
function tile(label: string): HTMLElement {
    const el = screen.getByText(label, { selector: 'p' }).closest('div.rounded-2xl')
    if (!el) throw new Error(`no tile ${label}`)
    return el as HTMLElement
}

/** The frame titled `title`. */
function frame(title: string): HTMLElement {
    const el = screen.getByRole('heading', { name: title }).closest('section')
    if (!el) throw new Error(`no frame ${title}`)
    return el as HTMLElement
}

describe('CollaborationTab', () => {
    it('leads with whether questions are answered, and how fast', () => {
        renderTab(COLLAB_PRIVILEGED)
        const { kpis } = COLLAB_PRIVILEGED

        expect(within(tile('Questions asked')).getByText(String(kpis.asked.current))).toBeInTheDocument()
        expect(within(tile('Questions asked')).getByText(signedPercent(kpis.asked.changePct)!)).toBeInTheDocument()
        expect(within(tile('Answer rate')).getByText(percent(kpis.answerRate.current))).toBeInTheDocument()
        expect(within(tile('Answer rate')).getByText(/was 64%/)).toBeInTheDocument()
        // 5.5 hours, said as a person would say it; faster is good news.
        const firstReply = tile('Time to first reply')
        expect(within(firstReply).getByText('6h')).toBeInTheDocument()
        expect(within(firstReply).getByText('-23.6%').closest('span')).toHaveClass('text-emerald-600')
        expect(within(tile('Waiting over a week')).getByText('5')).toBeInTheDocument()
        expect(within(tile('Waiting over a week')).getByText('19 open now')).toBeInTheDocument()
        expect(within(tile('Asked privately')).getByText('12%')).toBeInTheDocument()
        // Every tile explains itself.
        for (const term of ['Questions asked', 'Answer rate', 'Time to first reply', 'Waiting over a week', 'People answering']) {
            expect(screen.getByRole('button', { name: `What does "${term}" mean?` })).toBeInTheDocument()
        }
    })

    it('links the most discussed views to the view and sources to their Questions tab', () => {
        renderTab(COLLAB_PRIVILEGED)

        const views = frame('Most discussed views')
        expect(within(views).getByRole('link', { name: 'Revenue lineage' })).toHaveAttribute('href', '/views/v1')
        expect(within(views).getByText('32')).toBeInTheDocument()
        expect(within(views).getByText('9 asked · 3 open')).toBeInTheDocument()

        const sources = frame('Data sources with the most questions')
        expect(within(sources).getByRole('link', { name: 'Ledger' })).toHaveAttribute(
            'href', '/workspaces/ws2?tab=data&section=sources&ds=ds2&dstab=questions')
    })

    it('opens a workspace from its row, and links the longest-waiting questions to the thread', async () => {
        const user = userEvent.setup()
        const { onWorkspaceClick } = renderTab(COLLAB_PRIVILEGED)

        await user.click(within(frame('Workspaces asking most')).getByText('56% answered'))
        expect(onWorkspaceClick).toHaveBeenCalledWith('ws3')

        const waiting = frame('Longest-waiting questions')
        expect(within(waiting).getByRole('link', { name: 'Ledger' })).toHaveAttribute(
            'href', '/workspaces/ws2?tab=data&section=sources&ds=ds2&dstab=questions&discussion=d1')
        expect(within(waiting).getByRole('link', { name: 'Customer 360' })).toHaveAttribute(
            'href', '/views/v2?discussion=d3')
        // An administrator reads what was asked, and by whom — except for a
        // private question, whose words never reach the page.
        expect(within(waiting).getByText(/Why does the daily balance.*— Asha Patel/)).toBeInTheDocument()
        expect(within(waiting).getByText('Private question · Growth')).toBeInTheDocument()
        expect(within(waiting).getByText('23')).toBeInTheDocument()
        expect(within(frame('People who answer most')).getByText('Priya Raman')).toBeInTheDocument()
    })

    it('shows a redacted reader the counts, and nobody and nothing they may not see', () => {
        renderTab(COLLAB_STRICT)

        expect(screen.getByText('People who answer most is hidden')).toBeInTheDocument()
        expect(screen.queryByText('Priya Raman')).toBeNull()
        // A view in a workspace they are not in: counted, not named, not linked.
        const views = frame('Most discussed views')
        expect(within(views).getAllByText('Restricted view')).toHaveLength(3)
        expect(within(views).queryByRole('link', { name: 'Revenue lineage' })).toBeNull()
        expect(within(views).getByText('32')).toBeInTheDocument()
        expect(within(views).getByRole('link', { name: 'Customer 360' })).toBeInTheDocument()
        // Their own workspace's question is linked, without its words or asker.
        const waiting = frame('Longest-waiting questions')
        expect(within(waiting).getByRole('link', { name: 'Customer 360' })).toBeInTheDocument()
        expect(screen.queryByText(/churn flag/)).toBeNull()
        expect(screen.queryByText(/Asha Patel/)).toBeNull()
        expect(within(waiting).getByText('A private question')).toBeInTheDocument()
        expect(within(waiting).getAllByText('On a source you cannot see')).toHaveLength(2)
        expect(within(waiting).getByText('On a view you cannot see')).toBeInTheDocument()
        expect(within(waiting).getByText(/shown to administrators and auditors only/)).toBeInTheDocument()
        // Totals are the platform's, for everyone.
        expect(within(tile('Questions asked')).getByText(String(COLLAB_STRICT.kpis.asked.current))).toBeInTheDocument()
    })

    it('says no questions have been asked yet, and where to read about asking one', () => {
        renderTab(COLLAB_EMPTY)
        expect(screen.getByRole('heading', { name: 'No questions yet' })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'How asking questions works' }))
            .toHaveAttribute('href', '/guide/asking-questions')
        expect(screen.queryByText('Questions asked')).toBeNull()
    })

    it('says questions are switched off rather than that nobody asked', () => {
        renderTab(COLLAB_EMPTY, { conversations: false })
        expect(screen.getByRole('heading', { name: 'Questions are switched off' })).toBeInTheDocument()
        expect(screen.getByText(/Administration → Features/)).toBeInTheDocument()
    })

    it('keeps the history of a deployment that switched questions off, and says so', () => {
        renderTab(COLLAB_PRIVILEGED, { conversations: false })
        expect(screen.getByText(/Questions are switched off on this deployment/)).toBeInTheDocument()
        expect(frame('Most discussed views')).toBeInTheDocument()
    })
})
