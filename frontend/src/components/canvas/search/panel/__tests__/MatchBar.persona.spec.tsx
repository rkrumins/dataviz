/**
 * An answer that stopped short says what it means for the answer to
 * Business — how the engine got there one click away — and gives
 * Technical the engine's own account.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { usePersonaStore } from '@/store/persona'

import { MatchBar } from '../MatchBar'


function renderBar(over: { truncated?: boolean; deadlineExceeded?: boolean } = {}) {
    render(<MatchBar count={50000} elapsedMs={40} isRunning={false} candidateCount={50000}
                     viewId="view-1" {...over} />)
}


describe('MatchBar — an answer that stopped short', () => {
    afterEach(() => usePersonaStore.getState().setMode('business'))

    it('says so in plain words for Business, the engine\'s account a click away', () => {
        renderBar({ truncated: true, deadlineExceeded: true })
        expect(screen.getByText('Some matches aren’t shown')).toBeInTheDocument()
        expect(screen.getByText('Some matches may be missing')).toBeInTheDocument()
        expect(screen.queryByText(/candidates scanned before the cap fired/)).not.toBeInTheDocument()

        fireEvent.click(screen.getAllByRole('button', { name: 'Why?' })[0])
        expect(screen.getByText(/50,000 candidates scanned before the cap fired/)).toBeInTheDocument()
    })

    it('gives Technical the engine\'s own account', () => {
        usePersonaStore.getState().setMode('technical')
        renderBar({ truncated: true })
        expect(screen.getByText('Results truncated — candidate cap reached')).toBeInTheDocument()
        expect(screen.getByText(/50,000 candidates scanned before the cap fired/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Why?' })).not.toBeInTheDocument()
    })
})
