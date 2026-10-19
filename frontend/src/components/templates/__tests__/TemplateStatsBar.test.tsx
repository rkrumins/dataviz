/**
 * The Templates page's summary banner: what it counts from the library it is
 * given, and the tiles a template manager alone sees.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LayoutTemplate } from '@/services/layoutTemplateService'
import { TemplateStatsBar } from '../TemplateStatsBar'

const DAY = 24 * 60 * 60 * 1000
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()

const tpl = (id: string, over: Partial<LayoutTemplate>) => ({ id, usageCount: 0, updatedAt: ago(30), ...over }) as LayoutTemplate

const LIBRARY = [
    tpl('a', { usageCount: 4, updatedAt: ago(2), isFavourite: true }),
    tpl('b', { usageCount: 7, updatedAt: ago(10) }),
    tpl('c', { updatedAt: ago(0.5) }),
]

function renderBar(over: Partial<Parameters<typeof TemplateStatsBar>[0]> = {}) {
    const handlers = {
        onShowAll: vi.fn(), onShowMostUsed: vi.fn(), onShowRecentlyUpdated: vi.fn(),
        onShowFavourites: vi.fn(), onShowRequests: vi.fn(),
    }
    render(<TemplateStatsBar templates={LIBRARY} pendingRequests={null} {...handlers} {...over} />)
    return handlers
}

const tile = (label: string) => screen.getByText(label).closest('button')!

describe('TemplateStatsBar', () => {
    it('counts the library, the views using it, this week’s updates and your favorites', () => {
        renderBar()
        expect(tile('Templates')).toHaveTextContent('3')
        expect(tile('Views Using Them')).toHaveTextContent('11')
        expect(tile('Updated This Week')).toHaveTextContent('2')
        expect(tile('Your Favorites')).toHaveTextContent('1')
        expect(screen.getByText('Last Updated').previousSibling).toHaveTextContent('12h ago')
        expect(screen.queryByText('Awaiting Your Decision')).not.toBeInTheDocument()
    })

    it('shows what a tile counts when it is clicked', () => {
        const on = renderBar()
        fireEvent.click(tile('Templates'))
        fireEvent.click(tile('Views Using Them'))
        fireEvent.click(tile('Updated This Week'))
        fireEvent.click(tile('Your Favorites'))
        expect(on.onShowAll).toHaveBeenCalledOnce()
        expect(on.onShowMostUsed).toHaveBeenCalledOnce()
        expect(on.onShowRecentlyUpdated).toHaveBeenCalledOnce()
        expect(on.onShowFavourites).toHaveBeenCalledOnce()
    })

    it('shows a manager the requests waiting on them', () => {
        const on = renderBar({ pendingRequests: 2 })
        expect(tile('Awaiting Your Decision')).toHaveTextContent('2')
        fireEvent.click(tile('Awaiting Your Decision'))
        expect(on.onShowRequests).toHaveBeenCalledOnce()
    })

    it('waits for the library rather than counting nothing', () => {
        renderBar({ templates: [], isLoading: true })
        expect(tile('Templates')).toHaveTextContent('—')
        expect(screen.getByText('Last Updated').previousSibling).toHaveTextContent('—')
    })
})
