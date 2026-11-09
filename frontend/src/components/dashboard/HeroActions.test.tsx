/**
 * The hero's actions, in the order each view reads them. A Business reader comes to read, so
 * Browse leads in the primary style and Build follows Resume as a secondary one; the Technical
 * view keeps building first.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { HeroActions } from './dashboardWelcome'
import { usePersonaStore } from '@/store/persona'

function renderActions() {
    const handlers = { onCreateView: vi.fn(), onResume: vi.fn(), onBrowse: vi.fn() }
    render(<HeroActions {...handlers} resumeLabel="Q3 Hierarchy" />)
    return handlers
}

const order = () => screen.getAllByRole('button').map(b => b.textContent)
/** The primary style is the gradient fill; the secondary one is a glass panel. */
const isPrimary = (name: RegExp) => screen.getByRole('button', { name }).className.includes('bg-gradient-to-r')

describe('HeroActions', () => {
    it('leads a Business reader to browse, with building after picking up where they were', () => {
        usePersonaStore.setState({ mode: 'business' })
        renderActions()
        expect(order()).toEqual(['Browse all views', 'Pick upQ3 Hierarchy', 'Build a new view'])
        expect(isPrimary(/Browse all views/)).toBe(true)
        expect(isPrimary(/Build a new view/)).toBe(false)
    })

    it('keeps building first in the Technical view', () => {
        renderActions()
        expect(order()).toEqual(['Build a new view', 'Pick upQ3 Hierarchy', 'Browse all views'])
        expect(isPrimary(/Build a new view/)).toBe(true)
        expect(isPrimary(/Browse all views/)).toBe(false)
    })

    it.each(['business', 'technical'] as const)('fires each button’s own handler in the %s view', (mode) => {
        usePersonaStore.setState({ mode })
        const { onCreateView, onResume, onBrowse } = renderActions()
        fireEvent.click(screen.getByRole('button', { name: /Browse all views/ }))
        fireEvent.click(screen.getByRole('button', { name: /Q3 Hierarchy/ }))
        fireEvent.click(screen.getByRole('button', { name: /Build a new view/ }))
        expect(onBrowse).toHaveBeenCalledTimes(1)
        expect(onResume).toHaveBeenCalledTimes(1)
        expect(onCreateView).toHaveBeenCalledTimes(1)
    })
})
