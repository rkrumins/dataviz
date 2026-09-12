import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RunAttempt } from '@/services/aggregationService'
import { AttemptLog } from './AttemptLog'

const attempt = (over: Partial<RunAttempt> & { n: number }): RunAttempt => ({
    stage: 'applying', status: 'failed', progress: 62, secs: 1_860,
    category: 'write_budget', error: 'The shard had room for 120,000 more edges.',
    writes: 12_400, ended_at: new Date(Date.now() - 3_600_000).toISOString(),
    ...over,
})

describe('AttemptLog', () => {
    it('says which stage each attempt stopped in, how far it got and why', () => {
        render(<AttemptLog attempts={[attempt({ n: 1 })]} />)
        expect(screen.getByText('#1')).toBeInTheDocument()
        expect(screen.getByText(/stopped in Apply at 62%/)).toBeInTheDocument()
        expect(screen.getByText('Would not fit')).toBeInTheDocument()
        expect(screen.getByText(/12,400 written/)).toBeInTheDocument()
        expect(screen.getByText(/120,000 more edges/)).toBeInTheDocument()
    })

    it('is honest about an attempt whose worker vanished mid-stage', () => {
        // It never said where it stopped; the NEXT attempt captured it.
        render(<AttemptLog attempts={[attempt({ n: 2, stage: null, category: undefined })]} />)
        expect(screen.getByText(/stopped without saying where/)).toBeInTheDocument()
    })

    it('keeps the numbering it was given, even after the log was trimmed', () => {
        render(<AttemptLog attempts={[attempt({ n: 7 }), attempt({ n: 8 })]} />)
        expect(screen.getByText('2 earlier attempts')).toBeInTheDocument()
        expect(screen.getByText('#7')).toBeInTheDocument()
        expect(screen.getByText('#8')).toBeInTheDocument()
    })

    it('renders nothing for a run that never failed an attempt', () => {
        const { container } = render(<AttemptLog attempts={[]} />)
        expect(container).toBeEmptyDOMElement()
        expect(render(<AttemptLog attempts={undefined} />).container).toBeEmptyDOMElement()
    })
})
