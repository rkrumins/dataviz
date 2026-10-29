/**
 * A search still scanning says how far it has got and for how long, and
 * when it has found nothing new for a while, that the graph is busy rather
 * than stuck. It can be stopped where it is and resumed; one the graph
 * stayed out of reach for is paused, not "ran out of time". And a finished
 * search that left part of the graph out reads as a floor, and says which.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MatchBar, type MatchBarProps } from '../MatchBar'


function renderBar(over: Partial<MatchBarProps> = {}) {
    return render(<MatchBar count={1234} elapsedMs={40} isRunning={false} viewId="view-1"
                            {...over} />)
}

const SCANNING: Partial<MatchBarProps> = {
    scanning: true, progress: { scanned: 45, total: 100 },
}


describe('MatchBar — a scan in progress', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('counts what it found, how far it is, and for how long', () => {
        renderBar({ ...SCANNING, startedAt: performance.now() - 83_000 })
        expect(screen.getByText('found')).toBeInTheDocument()
        expect(screen.getByText('· scanning 45%')).toBeInTheDocument()
        expect(screen.getByText('· 1:23')).toBeInTheDocument()
        act(() => { vi.advanceTimersByTime(2_000) })
        expect(screen.getByText('· 1:25')).toBeInTheDocument()
    })

    it('says the graph is busy after a long stretch with nothing new', () => {
        const { rerender } = renderBar({ ...SCANNING, startedAt: performance.now() })
        act(() => { vi.advanceTimersByTime(19_000) })
        expect(screen.queryByText('The graph is busy — still working.')).not.toBeInTheDocument()
        act(() => { vi.advanceTimersByTime(2_000) })
        expect(screen.getByText('The graph is busy — still working.')).toBeInTheDocument()

        // Progress again: the note goes.
        rerender(<MatchBar count={1300} elapsedMs={40} isRunning={false} viewId="view-1"
                           {...SCANNING} progress={{ scanned: 50, total: 100 }} />)
        expect(screen.queryByText('The graph is busy — still working.')).not.toBeInTheDocument()
    })

    it('stops where it is', () => {
        const onStop = vi.fn()
        renderBar({ ...SCANNING, onStop })
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
        expect(onStop).toHaveBeenCalledTimes(1)
    })
})


describe('MatchBar — a scan no longer followed', () => {
    it('says it was stopped, keeps the count, and offers Resume', () => {
        const onResume = vi.fn()
        renderBar({ ...SCANNING, halted: { kind: 'stopped' }, onStop: vi.fn(), onResume })
        expect(screen.getByRole('status')).toHaveTextContent('Stopped. What it found so far is shown.')
        expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
        expect(onResume).toHaveBeenCalledTimes(1)
    })

    it('says a scan the graph stayed out of reach for is paused — not out of time', () => {
        renderBar({ ...SCANNING, halted: { kind: 'interrupted', reason: 'The graph store isn’t answering.' },
                    onResume: vi.fn() })
        expect(screen.getByRole('status')).toHaveTextContent(/Paused: the graph didn’t answer/)
        expect(screen.queryByText(/ran out of time/)).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument()
    })
})


describe('MatchBar — a count that is a floor', () => {
    it('reads "at least" and says which part of the graph was left out', () => {
        renderBar({
            countIsFloor: true, countIsExact: true,
            notes: ['“orders” (dataset) couldn’t be checked in time, so it was left out — there may '
                    + 'be more matches than shown.'],
        })
        expect(screen.getByText('at least')).toBeInTheDocument()
        expect(screen.getByRole('status')).toHaveTextContent(
            'Part of the graph couldn’t be checked, so there may be more matches than shown.')
        expect(screen.getByRole('status')).toHaveTextContent('“orders” (dataset) couldn’t be checked in time')
    })

    it('reads as a plain count otherwise', () => {
        renderBar({ countIsExact: true })
        expect(screen.queryByText('at least')).not.toBeInTheDocument()
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })
})


describe('MatchBar — how long a finished search took', () => {
    it.each([
        [432, '· 432 ms'],
        [4_200, '· 4.2 s'],
        // Past a minute, the clock a running search shows: not "87146 ms".
        [87_146, '· 1:27'],
    ])('%s ms reads %s', (elapsedMs, text) => {
        renderBar({ elapsedMs })
        expect(screen.getByText(text)).toBeInTheDocument()
    })
})
