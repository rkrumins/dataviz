/**
 * UpdateProgress — an update's progress in every state, from the server's figures alone: a
 * percentage only while rows are counted, a time only when the server gives one, never 100% before
 * the update is done and never "0 min left"; an accessible progressbar that says the whole
 * sentence, determinate while rows are counted, and still when the person asked for less motion.
 */
import { render, screen } from '@testing-library/react'
import { MotionConfig } from 'framer-motion'
import { describe, expect, it } from 'vitest'
import { progressOf as progress } from '@/harness/updateProgressFixtures'
import { UpdateProgress } from '../UpdateProgress'
import { aboutTime, describeProgress } from '../updateProgressWords'

const uncounted = { done: null, total: null, ratePerSec: null, etaSecs: null }

describe('describeProgress', () => {
    it.each([
        ['updating', {}, 'Version 42: 63% written, about 4 min left', 'Version 42 · 63% · about 4 min left'],
        ['updating', { etaSecs: null }, 'Version 42: 63% written', 'Version 42 · 63%'],
        ['seeding', {}, 'First copy of version 42: 63% written, about 4 min left', 'First copy of version 42 · 63% · about 4 min left'],
        ['loading', {}, 'Version 42: 63% loaded, about 4 min left', 'Loading version 42 · 63% · about 4 min left'],
        ['building', { etaSecs: 180 }, 'Version 42 is being built beside: 63% written, about 3 min left', 'Building version 42 · 63% · about 3 min left'],
        ['switching', { etaSecs: 180 }, 'Version 42 is being built beside: ready in about 3 min', 'Version 42 · ready in about 3 min'],
        ['switching', { etaSecs: null }, 'Version 42 is being built beside: 63% caught up', 'Version 42 · 63%'],
    ] as const)('says %s %j as the server has it', (phase, over, sentence, short) => {
        const w = describeProgress(progress({ phase, ...over }))
        expect([w.sentence, w.short, w.percent]).toEqual([sentence, short, 63])
    })

    it.each([
        ['updating', 'Updating to version 42', 'Updating to version 42'],
        ['seeding', 'Writing the first copy of version 42', 'First copy of version 42'],
        ['loading', 'Loading version 42 into memory', 'Loading version 42'],
        ['building', 'Version 42 is being built beside', 'Building version 42 beside'],
        ['switching', 'Version 42 is being built beside: catching up before the switch', 'Version 42: catching up'],
    ] as const)('says a %s that counts no rows by its phase alone: no percentage, no time', (phase, sentence, short) => {
        const w = describeProgress(progress({ phase, ...uncounted }))
        expect(w).toEqual({ label: w.label, sentence, short, bare: null, percent: null, timeLeft: null })
    })

    it('never says 100% before it is done, nor a percentage it rounded up', () => {
        expect(describeProgress(progress({ done: 9_999 })).percent).toBe(99)
        expect(describeProgress(progress({ done: 6_399 })).percent).toBe(63)
        const all = describeProgress(progress({ done: 10_000, etaSecs: null }))
        expect([all.sentence, all.percent, all.timeLeft]).toEqual(['Version 42: finishing up', 99, null])
    })

    it('says it is starting before its first rows land', () => {
        const w = describeProgress(progress({ done: 0, etaSecs: null }))
        expect([w.sentence, w.short, w.percent]).toEqual(['Version 42: starting', 'Version 42 · starting', 0])
    })

    it('adds only what a host that names the version lacks, and nothing when there is nothing', () => {
        expect(describeProgress(progress()).bare).toBe('63% · about 4 min left')
        expect(describeProgress(progress({ phase: 'building', ...uncounted })).bare).toBeNull()
    })

    it('names the new version even when the server could not', () => {
        expect(describeProgress(progress({ targetVersion: null, targetSeq: null, ...uncounted })).sentence)
            .toBe('Updating to the new version')
        expect(describeProgress(progress({ targetVersion: null, targetSeq: 7 })).sentence)
            .toMatch(/^Version 7: /)
    })
})

describe('aboutTime', () => {
    it('rounds to what a person would say, never "0 min"', () => {
        expect(aboutTime(1)).toBe('less than a minute')
        expect(aboutTime(59)).toBe('less than a minute')
        expect(aboutTime(60)).toBe('about 1 min')
        expect(aboutTime(89)).toBe('about 1 min')
        expect(aboutTime(150)).toBe('about 3 min')
        expect(aboutTime(59 * 60)).toBe('about 59 min')
        expect(aboutTime(3600)).toBe('about 1 h')
        expect(aboutTime(95 * 60)).toBe('about 1 h 35 min')
        expect(aboutTime(97 * 60)).toBe('about 1 h 35 min')
    })
})

describe('UpdateProgress', () => {
    it('draws nothing while no update is in flight', () => {
        const { container } = render(<UpdateProgress progress={null} />)
        expect(container).toBeEmptyDOMElement()
    })

    it('shows the phase, the sentence, a determinate bar and the rows, their rate and start', () => {
        render(<UpdateProgress progress={progress()} />)
        expect(screen.getByText('Updating')).toBeInTheDocument()
        expect(screen.getByText('Version 42: 63% written, about 4 min left')).toBeInTheDocument()
        const bar = screen.getByRole('progressbar', { name: 'Updating progress' })
        expect(bar).toHaveAttribute('aria-valuenow', '63')
        expect(bar).toHaveAttribute('aria-valuetext', 'Version 42: 63% written, about 4 min left')
        expect(bar.querySelector('[data-part="fill"]')).toHaveStyle({ width: '63%' })
        expect(screen.getByText(/^6,300 of 10,000 rows · 25 rows a second ·$/)).toHaveTextContent('started 3 min ago')
    })

    it('draws a phase that counts no rows as an indeterminate bar, with no figures', () => {
        render(<UpdateProgress progress={progress({ phase: 'building', ...uncounted })} />)
        const bar = screen.getByRole('progressbar', { name: 'Building beside progress' })
        expect(bar).not.toHaveAttribute('aria-valuenow')
        expect(bar).toHaveAttribute('aria-valuetext', 'Version 42 is being built beside')
        expect(bar.querySelector('[data-part="sweep"]')).toHaveClass('animate-indeterminate')
        expect(document.body.textContent).not.toMatch(/%|left|rows/)
    })

    it('keeps still when the person asked for less motion', () => {
        render(
            <MotionConfig reducedMotion="always">
                <UpdateProgress progress={progress({ phase: 'building', ...uncounted })} />
                <UpdateProgress progress={progress()} />
            </MotionConfig>,
        )
        const [sweep, fill] = screen.getAllByRole('progressbar')
        expect(sweep.querySelector('[data-part="sweep"]')).toBeNull()
        expect(sweep.querySelector('[data-part="still"]')).not.toBeNull()
        expect(fill.querySelector('[data-part="fill"]')).toHaveClass('transition-none')
        expect(document.querySelector('.animate-pulse-soft')).toBeNull()
    })

    it('in a chip, says a few words beside a mini bar, the whole sentence to assistive tech', () => {
        render(<UpdateProgress progress={progress()} variant="chip" />)
        expect(screen.getByText('Version 42 · 63% · about 4 min left')).toBeInTheDocument()
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Version 42: 63% written, about 4 min left')
    })

    it('in a chip whose host names the version, adds only the percentage and the time, or nothing', () => {
        const { rerender, container } = render(<UpdateProgress progress={progress()} variant="chip" withVersion={false} />)
        expect(screen.getByText('63% · about 4 min left')).toBeInTheDocument()
        rerender(<UpdateProgress progress={progress({ phase: 'loading', ...uncounted })} variant="chip" withVersion={false} />)
        expect(container).toBeEmptyDOMElement()
    })

    it('says a rate of one row a second in the singular, and a slow one to a tenth', () => {
        const { rerender } = render(<UpdateProgress progress={progress({ ratePerSec: 1 })} />)
        expect(screen.getByText(/1 row a second/)).toBeInTheDocument()
        rerender(<UpdateProgress progress={progress({ ratePerSec: 2.46 })} />)
        expect(screen.getByText(/2\.5 rows a second/)).toBeInTheDocument()
    })
})
