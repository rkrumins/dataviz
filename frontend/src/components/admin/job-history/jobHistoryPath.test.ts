/**
 * Deep links into Job History need no new routing: IngestionPage reads
 * ?tab=, and paramsToFilters already parses repeatable dataSourceId and
 * status params. This helper must emit exactly what paramsToFilters reads,
 * so the two are asserted against each other rather than against a string.
 */
import { describe, expect, it } from 'vitest'
import { jobHistoryPath, paramsToFilters } from './shared'

describe('jobHistoryPath', () => {
    it('targets the jobs tab', () => {
        expect(jobHistoryPath()).toBe('/ingestion?tab=jobs')
    })

    it('emits params paramsToFilters can read back', () => {
        const path = jobHistoryPath({ dataSourceId: 'ds_1', status: ['running', 'pending'] })
        const filters = paramsToFilters(new URLSearchParams(path.split('?')[1]))
        expect(filters.dataSourceId).toEqual(['ds_1'])
        expect(filters.status).toEqual(['running', 'pending'])
    })

    it('omits absent options', () => {
        expect(jobHistoryPath({ dataSourceId: 'ds_1' })).toBe('/ingestion?tab=jobs&dataSourceId=ds_1')
    })
})

// ── Reconciliation deep links ───────────────────────────────────────
// The runs panel links to "the rebuilds this run started" and the drawer to
// "the job this finding produced". Both must land on filter state the user
// could have set by hand, or the link silently shows the wrong jobs.

describe('jobHistoryPath — reconciliation links', () => {
    it('uses the same param names paramsToFilters reads', () => {
        const url = jobHistoryPath({ triggerSource: 'reconcile', dateFrom: '2026-08-14' })
        const params = new URLSearchParams(url.split('?')[1])
        const filters = paramsToFilters(params)
        expect(filters.triggerSource).toBe('reconcile')
        expect(filters.dateFrom).toBe('2026-08-14')
    })

    it('round-trips a job id through search', () => {
        const url = jobHistoryPath({ search: 'agg_abc123' })
        const filters = paramsToFilters(new URLSearchParams(url.split('?')[1]))
        expect(filters.search).toBe('agg_abc123')
    })

    it('omits every filter it was not given', () => {
        expect(jobHistoryPath()).toBe('/ingestion?tab=jobs')
    })
})
