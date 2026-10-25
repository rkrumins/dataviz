/**
 * The first-run tip: it points at Search Studio once per browser, with the
 * guide a click away, and goes for good when dismissed or once the Studio
 * has been opened, by whatever way in.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'

import { useSearchStore } from '@/store/searchStore'

import { SearchCoachmark } from '../SearchCoachmark'
import { SEARCH_INTRO_KEY } from '../searchIntro'


/** The control it points at, laid out where jsdom lays nothing out. */
function control(width = 28): HTMLButtonElement {
    const el = document.createElement('button')
    el.getBoundingClientRect = () => ({ top: 12, left: 420, width, height: 28 }) as DOMRect
    document.body.appendChild(el)
    return el
}


describe('SearchCoachmark', () => {
    beforeEach(() => {
        localStorage.clear()
        useSearchStore.getState().setStudioOpen(false)
    })

    it('points at Search Studio once, with the guide a click away, until dismissed', () => {
        const anchor = control()
        const { unmount } = render(<SearchCoachmark anchor={anchor} />, { wrapper: MemoryRouter })
        expect(screen.getByRole('status')).toHaveTextContent(/New — Search Studio\./)
        expect(screen.getByRole('link', { name: /How search works/ })).toHaveAttribute('href', '/guide/advanced-search')

        fireEvent.click(screen.getByRole('button', { name: 'Got it' }))
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
        expect(localStorage.getItem(SEARCH_INTRO_KEY)).toBe('1')
        unmount()
        render(<SearchCoachmark anchor={anchor} />, { wrapper: MemoryRouter })
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })

    it('is done once the Studio has been opened, however it was', () => {
        render(<SearchCoachmark anchor={control()} />, { wrapper: MemoryRouter })
        expect(screen.getByRole('status')).toBeInTheDocument()
        act(() => useSearchStore.getState().setStudioOpen(true))
        act(() => useSearchStore.getState().setStudioOpen(false))
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
        expect(localStorage.getItem(SEARCH_INTRO_KEY)).toBe('1')
    })

    it('has nothing to point from while its control is hidden', () => {
        render(<SearchCoachmark anchor={control(0)} />, { wrapper: MemoryRouter })
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })
})
