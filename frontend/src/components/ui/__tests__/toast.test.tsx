/**
 * The app-wide toast is the only feedback a great many actions produce. If it
 * isn't announced, those actions are silent to anyone not watching the
 * bottom-right corner of the screen.
 */
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'

import { ToastContainer, useToastStore } from '../toast'

beforeEach(() => {
    act(() => { useToastStore.setState({ toasts: [], _nextId: 1 }) })
})

function show(type: 'success' | 'error' | 'warning', message: string) {
    act(() => { useToastStore.getState().addToast({ type, message }) })
}

describe('ToastContainer', () => {
    it('announces a toast as a live status', () => {
        render(<ToastContainer />)
        show('success', 'View saved')

        const toast = screen.getByRole('status')
        expect(toast).toHaveTextContent('View saved')
        expect(toast).toHaveAttribute('aria-live', 'polite')
    })

    it('interrupts for an error, waits its turn otherwise', () => {
        render(<ToastContainer />)
        show('error', 'Save failed')
        show('warning', 'Mapping not saved')

        const [error, warning] = screen.getAllByRole('status')
        expect(error).toHaveTextContent('Save failed')
        expect(error).toHaveAttribute('aria-live', 'assertive')
        expect(warning).toHaveTextContent('Mapping not saved')
        expect(warning).toHaveAttribute('aria-live', 'polite')
    })
})
