/**
 * The coach mark on "Set up with a guide": once per browser, in the Business view, for an editor.
 * It waits while a tour runs and until the Business view's own intro has been seen, so two cards
 * never show at once; it is done on "Got it", or once the guide opens by any route.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { markPersonaIntroSeen, PERSONA_INTRO_KEY } from '@/components/persona/personaIntro'
import { useTourStore } from '@/features/tour/tourStore'
import { usePersonaStore } from '@/store/persona'
import { AdminVersionedGraphs } from '..'
import { SetupCoachMark } from '../SetupCoachMark'
import { SETUP_INTRO_KEY } from '../setupIntro'
import { allowMenus, mockApi, renderWithApi } from './helpers'

/** The button it points at, laid out where jsdom lays nothing out. */
function button(width = 180): HTMLButtonElement {
    const el = document.createElement('button')
    el.getBoundingClientRect = () => ({ top: 320, left: 300, width, height: 36 }) as DOMRect
    document.body.appendChild(el)
    return el
}

const tip = () => screen.queryByRole('status')

beforeAll(allowMenus)
beforeEach(() => {
    localStorage.removeItem(SETUP_INTRO_KEY)
    localStorage.setItem(PERSONA_INTRO_KEY, '1')
    usePersonaStore.setState({ mode: 'business' })
    useTourStore.setState({ activeTourId: null })
})
afterEach(() => usePersonaStore.setState({ mode: 'technical' }))

describe('SetupCoachMark', () => {
    it('points an editor at the guide once, with the guide to read, until "Got it"', () => {
        const anchor = button()
        const { unmount } = render(<SetupCoachMark anchor={anchor} />, { wrapper: MemoryRouter })
        expect(tip()).toHaveTextContent(/New: set up with a guide\./)
        expect(tip()).toHaveTextContent('Nothing is saved until you save it there.')
        expect(screen.getByRole('link', { name: /How the guide works/ })).toHaveAttribute('href', '/guide/governance-ops')

        fireEvent.click(screen.getByRole('button', { name: 'Got it' }))
        expect(tip()).not.toBeInTheDocument()
        expect(localStorage.getItem(SETUP_INTRO_KEY)).toBe('1')
        unmount()
        render(<SetupCoachMark anchor={anchor} />, { wrapper: MemoryRouter })
        expect(tip()).not.toBeInTheDocument()
    })

    it('waits until the Business view’s own intro has been seen', () => {
        localStorage.removeItem(PERSONA_INTRO_KEY)
        render(<SetupCoachMark anchor={button()} />, { wrapper: MemoryRouter })
        expect(tip()).not.toBeInTheDocument()
        act(() => markPersonaIntroSeen())
        expect(tip()).toBeInTheDocument()
    })

    it('waits while a guided tour is running', () => {
        useTourStore.setState({ activeTourId: 'getting-started' })
        render(<SetupCoachMark anchor={button()} />, { wrapper: MemoryRouter })
        expect(tip()).not.toBeInTheDocument()
        act(() => useTourStore.setState({ activeTourId: null }))
        expect(tip()).toBeInTheDocument()
    })

    it('never shows in the Technical view, nor without its button', () => {
        usePersonaStore.setState({ mode: 'technical' })
        const { unmount } = render(<SetupCoachMark anchor={button()} />, { wrapper: MemoryRouter })
        expect(tip()).not.toBeInTheDocument()
        unmount()
        usePersonaStore.setState({ mode: 'business' })
        render(<SetupCoachMark anchor={button(0)} />, { wrapper: MemoryRouter })
        expect(tip()).not.toBeInTheDocument()
        expect(localStorage.getItem(SETUP_INTRO_KEY)).toBeNull()
    })
})

describe('SetupCoachMark on the Settings page', () => {
    // jsdom lays nothing out: the hero's button needs a place on screen to be pointed at.
    beforeEach(() => {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 320, left: 300, width: 180, height: 36 } as DOMRect)
    })
    afterEach(() => vi.restoreAllMocks())

    it('points at the hero’s "Set up with a guide", and is done once the guide opens', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: '/admin/versioned-graphs?tab=settings' })
        const start = await screen.findByRole('button', { name: 'Set up with a guide' })
        expect(await screen.findByText('New: set up with a guide.')).toBeInTheDocument()
        await userEvent.click(start)
        expect(await screen.findByRole('dialog', { name: 'Guided setup' })).toBeInTheDocument()
        expect(screen.queryByText('New: set up with a guide.')).not.toBeInTheDocument()
        expect(localStorage.getItem(SETUP_INTRO_KEY)).toBe('1')
    })

    it('is not shown to someone who may only read the settings', async () => {
        mockApi('readonly')
        renderWithApi(<AdminVersionedGraphs />, { path: '/admin/versioned-graphs?tab=settings' })
        expect(await screen.findByText(/Only a system admin can change them/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Set up with a guide' })).not.toBeInTheDocument()
        expect(screen.queryByText('New: set up with a guide.')).not.toBeInTheDocument()
    })
})
