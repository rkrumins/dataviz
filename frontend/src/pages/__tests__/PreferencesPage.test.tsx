/**
 * Preferences: the Dashboard's Needs attention stays off until someone turns it
 * on here, and the switch says plainly when there would be nothing to show.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { access } = vi.hoisted(() => ({ access: { canRead: true } }))
vi.mock('@/hooks/useProfilingAccess', () => ({ useCanReadProfiling: () => access.canRead }))
vi.mock('@/services/authService', () => ({
    authService: { listMyIdentities: vi.fn().mockResolvedValue({ passwordSet: true, identities: [] }) },
}))
vi.mock('@/components/layout/AvatarPickerDialog', () => ({ AvatarPickerDialog: () => null }))

import { usePreferencesStore } from '@/store/preferences'
import { PreferencesPage } from '../PreferencesPage'

const renderPage = () => render(<MemoryRouter><PreferencesPage /></MemoryRouter>)
const toggle = () => screen.getByRole('switch', { name: 'Show Needs attention on the Dashboard' })

beforeEach(() => {
    access.canRead = true
    usePreferencesStore.setState({ showNeedsAttention: false })
})

describe('PreferencesPage', () => {
    it('turns Needs attention on and off', () => {
        renderPage()
        expect(toggle()).toHaveAttribute('aria-checked', 'false')

        fireEvent.click(toggle())
        expect(usePreferencesStore.getState().showNeedsAttention).toBe(true)
        expect(toggle()).toHaveAttribute('aria-checked', 'true')

        // The words beside the switch are a click target too.
        fireEvent.click(screen.getByText('Needs attention'))
        expect(usePreferencesStore.getState().showNeedsAttention).toBe(false)
    })

    it('explains, and offers nothing, to someone who cannot see profiling results', () => {
        access.canRead = false
        renderPage()
        expect(toggle()).toBeDisabled()
        expect(screen.getByText(/can’t see profiling results/)).toBeInTheDocument()
    })
})
