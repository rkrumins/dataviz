/**
 * "Refresh complete · 31/31" over a list of ds_ ids tells an operator
 * nothing — least of all that most of those 31 merely QUEUED work that has
 * not started. This list names each source, says what happened, and counts
 * queued separately from finished.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { BatchResultsList, describeActions } from './BatchResultsList'

const results = [
    { dataSourceId: 'ds_1', name: 'Solidatus Perf Xlarge', outcome: 'done' as const,
      jobId: 'job_1', actions: ['content_cleared', 'rebuild_queued'], deferred: false },
    { dataSourceId: 'ds_2', name: 'Nexus Lineage', outcome: 'done' as const,
      jobId: null, actions: ['content_cleared'], deferred: false },
    { dataSourceId: 'ds_3', name: 'Manual Lineage', outcome: 'done' as const,
      jobId: null, actions: [], deferred: true },
    { dataSourceId: 'ds_4', name: null, outcome: 'error' as const, jobId: null },
]

describe('BatchResultsList', () => {
    it('names each source and falls back to the id', () => {
        render(<BatchResultsList results={results} />, { wrapper: MemoryRouter })
        expect(screen.getByText('Solidatus Perf Xlarge')).toBeInTheDocument()
        expect(screen.getByText('ds_4')).toBeInTheDocument()
    })

    it('counts queued rebuilds separately from finished work', () => {
        render(<BatchResultsList results={results} />, { wrapper: MemoryRouter })
        expect(screen.getByText(/1 rebuild queued/)).toBeInTheDocument()
        expect(screen.getByText(/1 deferred/)).toBeInTheDocument()
        expect(screen.getByText(/1 failed/)).toBeInTheDocument()
    })

    it('links a queued source to its job', () => {
        render(<BatchResultsList results={results} />, { wrapper: MemoryRouter })
        expect(screen.getByRole('link', { name: /View job/ }))
            .toHaveAttribute('href', '/ingestion?tab=jobs&dataSourceId=ds_1')
    })

    it('explains a deferral rather than showing a bare tick', () => {
        render(<BatchResultsList results={results} />, { wrapper: MemoryRouter })
        expect(screen.getByText(/in cooldown/)).toBeInTheDocument()
    })
})

describe('describeActions', () => {
    it('humanizes known actions', () => {
        expect(describeActions(['content_cleared', 'rebuild_queued'])).toBe('cache cleared · rebuild queued')
    })

    it('passes unknown actions through rather than hiding them', () => {
        expect(describeActions(['warp_drive_engaged'])).toBe('warp drive engaged')
    })

    it('says something for an empty list', () => {
        expect(describeActions([])).toBe('no changes needed')
    })
})
