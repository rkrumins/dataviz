/**
 * The Business view's first-run tip: it tells a reader once where the other
 * tools went and how to bring them back, and goes for good when dismissed or
 * once the persona has been changed, by whatever way.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'

import { useTourStore } from '@/features/tour/tourStore'
import { usePersonaStore } from '@/store/persona'

import { PersonaIntroTip } from '../PersonaIntroTip'
import { PERSONA_INTRO_KEY } from '../personaIntro'


/** The toggle it points at, laid out where jsdom lays nothing out. */
function toggle(width = 180): HTMLSpanElement {
    const el = document.createElement('span')
    el.getBoundingClientRect = () => ({ top: 12, left: 900, width, height: 36 }) as DOMRect
    document.body.appendChild(el)
    return el
}


describe('PersonaIntroTip', () => {
    beforeEach(() => {
        localStorage.clear()
        usePersonaStore.setState({ mode: 'business' })
        useTourStore.setState({ activeTourId: null })
    })

    it('tells a Business reader once where the other tools went, until dismissed', () => {
        const anchor = toggle()
        const { unmount } = render(<PersonaIntroTip anchor={anchor} />, { wrapper: MemoryRouter })
        expect(screen.getByRole('status')).toHaveTextContent(/New — a simpler Business view\./)
        expect(screen.getByRole('link', { name: /Business or Technical\?/ })).toHaveAttribute('href', '/guide/key-concepts')

        fireEvent.click(screen.getByRole('button', { name: 'Got it' }))
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
        expect(localStorage.getItem(PERSONA_INTRO_KEY)).toBe('1')
        unmount()
        render(<PersonaIntroTip anchor={anchor} />, { wrapper: MemoryRouter })
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })

    it('"Show every tool" switches to the Technical view, and the tip is done', () => {
        render(<PersonaIntroTip anchor={toggle()} />, { wrapper: MemoryRouter })
        fireEvent.click(screen.getByRole('button', { name: 'Show every tool' }))
        expect(usePersonaStore.getState().mode).toBe('technical')
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
        expect(localStorage.getItem(PERSONA_INTRO_KEY)).toBe('1')
    })

    it('is done once the persona changes by any route, even if it comes back', () => {
        render(<PersonaIntroTip anchor={toggle()} />, { wrapper: MemoryRouter })
        act(() => usePersonaStore.getState().toggleMode())
        act(() => usePersonaStore.getState().toggleMode())
        expect(usePersonaStore.getState().mode).toBe('business')
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
        expect(localStorage.getItem(PERSONA_INTRO_KEY)).toBe('1')
    })

    it('never shows in the Technical view', () => {
        usePersonaStore.setState({ mode: 'technical' })
        render(<PersonaIntroTip anchor={toggle()} />, { wrapper: MemoryRouter })
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
        expect(localStorage.getItem(PERSONA_INTRO_KEY)).toBeNull()
    })

    it('waits while a guided tour is running', () => {
        useTourStore.setState({ activeTourId: 'getting-started' })
        render(<PersonaIntroTip anchor={toggle()} />, { wrapper: MemoryRouter })
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
        act(() => useTourStore.setState({ activeTourId: null }))
        expect(screen.getByRole('status')).toBeInTheDocument()
    })

    it('has nothing to point from while the toggle is hidden', () => {
        render(<PersonaIntroTip anchor={toggle(0)} />, { wrapper: MemoryRouter })
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })
})
