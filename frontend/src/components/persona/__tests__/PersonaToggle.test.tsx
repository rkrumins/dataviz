/**
 * The top bar's Business / Technical switch: a radio group of two — one tab
 * stop, the arrow keys and Home / End move the choice, each option announces
 * the ⌘/ shortcut — with a tooltip on what each view keeps.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { usePersonaStore } from '@/store/persona'

import { PersonaToggle } from '../PersonaToggle'


const mode = () => usePersonaStore.getState().mode

function renderToggle() {
    render(<PersonaToggle />)
    return {
        business: screen.getByRole('radio', { name: 'Business' }),
        technical: screen.getByRole('radio', { name: 'Technical' }),
    }
}

const tabStops = () => screen.getAllByRole('radio').filter((r) => r.tabIndex === 0)


describe('PersonaToggle', () => {
    beforeEach(() => {
        usePersonaStore.setState({ mode: 'business' })
    })

    it('is a radio group of the two views whose choice follows the store, with one tab stop', () => {
        const { business, technical } = renderToggle()
        const group = screen.getByRole('radiogroup', { name: 'Business or Technical view' })
        expect(screen.getAllByRole('radio')).toEqual([business, technical])
        expect(group).toContainElement(business)
        expect(business).toHaveAttribute('aria-checked', 'true')
        expect(technical).toHaveAttribute('aria-checked', 'false')
        expect(tabStops()).toEqual([business])

        act(() => usePersonaStore.getState().setMode('technical'))
        expect(business).toHaveAttribute('aria-checked', 'false')
        expect(technical).toHaveAttribute('aria-checked', 'true')
        expect(tabStops()).toEqual([technical])
    })

    it('a click chooses that view', () => {
        const { business, technical } = renderToggle()
        fireEvent.click(technical)
        expect(mode()).toBe('technical')
        fireEvent.click(business)
        expect(mode()).toBe('business')
    })

    it('the arrow keys move the choice and the focus with it, wrapping round', () => {
        const { business, technical } = renderToggle()
        act(() => business.focus())
        fireEvent.keyDown(business, { key: 'ArrowRight' })
        expect(mode()).toBe('technical')
        expect(technical).toHaveFocus()
        fireEvent.keyDown(technical, { key: 'ArrowLeft' })
        expect(mode()).toBe('business')
        expect(business).toHaveFocus()
        fireEvent.keyDown(business, { key: 'ArrowLeft' })
        expect(mode()).toBe('technical')
        expect(technical).toHaveFocus()
    })

    it('Home and End go to the first and the last view', () => {
        const { business, technical } = renderToggle()
        act(() => business.focus())
        fireEvent.keyDown(business, { key: 'End' })
        expect(mode()).toBe('technical')
        expect(technical).toHaveFocus()
        fireEvent.keyDown(technical, { key: 'Home' })
        expect(mode()).toBe('business')
        expect(business).toHaveFocus()
    })

    it('announces the shortcut on each option, the way this platform writes it', () => {
        const { business, technical } = renderToggle()
        // jsdom is not an Apple platform.
        expect(business).toHaveAttribute('aria-keyshortcuts', 'Control+/')
        expect(technical).toHaveAttribute('aria-keyshortcuts', 'Control+/')
    })

    it('on focus, a tooltip says what each view keeps, with the shortcut, and nothing uses a native title', async () => {
        const { business } = renderToggle()
        act(() => business.focus())
        const tip = await screen.findByRole('tooltip')
        expect(tip).toHaveAttribute('data-tip-width', 'data')
        expect(tip).toHaveTextContent('Business keeps the essentials: fewer tools, names as people say them.')
        expect(tip).toHaveTextContent('Technical adds every tool, and each entity’s identifier under its name.')
        expect(tip).toHaveTextContent('Same graph either way')
        expect(tip).toHaveTextContent('Ctrl+/')
        expect(document.querySelectorAll('[title]')).toHaveLength(0)
    })
})
