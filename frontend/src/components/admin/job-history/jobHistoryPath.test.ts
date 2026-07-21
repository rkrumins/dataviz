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
