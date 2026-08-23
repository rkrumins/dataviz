/**
 * Reported: "the one that fires doesn't even come on half the time".
 *
 * The counters were `title` attributes. A native tooltip waits about a second,
 * does not re-fire when the pointer moves within one element, and — the part
 * that made it feel random — an Explorer card swaps in its hover controls the
 * moment the pointer enters it, so the element under the cursor is frequently
 * replaced before the browser gets round to showing anything.
 *
 * These hover the icons on a REAL card, after the card itself is hovered, which
 * is the sequence a person actually performs.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { ExplorerViewCard } from '../ExplorerViewCard'
import type { ViewUsage } from '@/services/contentInsightsService'
import type { View } from '@/services/viewApiService'

const VIEW = {
    id: 'v1', name: 'Agg Perf Test', viewType: 'reference',
    visibility: 'workspace', favouriteCount: 0, isFavourited: false,
    createdBy: 'u1', createdByName: 'System Admin',
    // The card colours its workspace chip by hashing this, so it must be a
    // real string rather than an omission the fixture gets away with.
    workspaceId: 'ws1', workspaceName: 'Sandbox',
    createdAt: '2026-07-11T20:05:00+00:00',
    updatedAt: '2026-08-19T13:06:00+00:00',
    tags: [], config: {},
} as unknown as View

const USAGE: ViewUsage = {
    viewId: 'v1', opens: 0, uniqueViewers: 0, lastOpenedAt: null, trend: [],
    windowDays: 30, lifetimeOpens: 0, onlyAuthor: false,
    yourOpens: 0, yourLastOpenedAt: null,
}

function renderCard(usage: ViewUsage = USAGE) {
    return render(
        <MemoryRouter>
            <ExplorerViewCard
                view={VIEW}
                usage={usage}
                onToggleFavourite={vi.fn()}
                onShare={vi.fn()}
            />
        </MemoryRouter>,
    )
}

describe('usage tooltips on a real Explorer card', () => {
    it('explains all three footer icons, after the card is hovered', async () => {
        const user = userEvent.setup()
        const { container } = renderCard()

        // The sequence that broke: pointer enters the card first, which is
        // when the card swaps in its hover controls.
        await user.hover(container.firstElementChild as HTMLElement)

        // Handle = the trigger's own screen-reader sentence; expected = what
        // the panel leads with, which is the figure rather than the sentence.
        for (const [handle, expected] of [
            [/Nobody has favourited this/, 'No favourites'],
            [/Nobody has opened this in the last 30 days/, 'Nobody yet'],
            [/Not opened in the last 30 days/, 'Not opened'],
        ] as const) {
            // Captured BEFORE hovering: the sr-only text and the panel can
            // both match, so a second lookup would find two elements.
            const trigger = screen.getByText(handle)
            await user.hover(trigger)
            expect(await screen.findByRole('tooltip')).toHaveTextContent(expected)
            await user.unhover(trigger)
        }
    })

    it('explains the same icons when the numbers are real', async () => {
        const user = userEvent.setup()
        renderCard({
            ...USAGE, opens: 340, uniqueViewers: 12, lifetimeOpens: 4_000,
        })

        await user.hover(screen.getByText(/12 different people have opened/))
        const tip = await screen.findByRole('tooltip')
        expect(tip).toHaveTextContent('12 people')
        expect(tip).toHaveTextContent(/have opened this in the last 30 days/)
    })
})
