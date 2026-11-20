/**
 * Preferences: the Dashboard's Needs attention stays off until someone turns it
 * on here, and the switch says plainly when there would be nothing to show. The
 * depth a new trace opens on is set here, each way, within the hops a trace walks.
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

    it('opens details on select per view: off for Business, on for Technical, each changeable', () => {
        usePreferencesStore.setState({ openDetailsOnSelect: { business: false, technical: true } })
        renderPage()
        const business = screen.getByRole('switch', { name: /in the business view/i })
        const technical = screen.getByRole('switch', { name: /in the technical view/i })
        expect(business).toHaveAttribute('aria-checked', 'false')
        expect(technical).toHaveAttribute('aria-checked', 'true')

        fireEvent.click(business)
        expect(usePreferencesStore.getState().openDetailsOnSelect).toEqual({ business: true, technical: true })
        fireEvent.click(technical)
        expect(usePreferencesStore.getState().openDetailsOnSelect).toEqual({ business: true, technical: false })
    })
})

describe('PreferencesPage — Lineage trace', () => {
    it('sets the depth a new trace opens on, each way, within the hops a trace walks', () => {
        usePreferencesStore.setState({ defaultTraceDepth: { up: 1, down: 1 } })
        renderPage()
        const up = screen.getByLabelText('Upstream')
        const down = screen.getByLabelText('Downstream')
        expect(up).toHaveValue(1)
        expect(down).toHaveValue(1)

        fireEvent.change(up, { target: { value: '3' } })
        expect(usePreferencesStore.getState().defaultTraceDepth).toEqual({ up: 3, down: 1 })
        fireEvent.change(down, { target: { value: '80' } })
        expect(usePreferencesStore.getState().defaultTraceDepth).toEqual({ up: 3, down: 25 })
        expect(screen.getByText('Every hop')).toBeInTheDocument()
        fireEvent.change(up, { target: { value: '0' } })
        expect(screen.getByText('Hidden')).toBeInTheDocument()
        usePreferencesStore.setState({ defaultTraceDepth: { up: 1, down: 1 } })
    })
})
