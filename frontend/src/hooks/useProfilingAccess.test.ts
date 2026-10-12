import { describe, expect, it } from 'vitest'
import { INGESTION_READ_PERMS } from './useProfilingAccess'

describe('history access mirrors the backend gate', () => {
    it('lists exactly what _INGESTION_READ_PERMS lists, in order', () => {
        // backend/app/api/v1/endpoints/aggregation.py :: _INGESTION_READ_PERMS
        // A front end stricter than the API blanks the page for someone the
        // server would have answered; looser, and it renders a 403. Missing
        // `system:org-admin` here was exactly the first of those.
        expect([...INGESTION_READ_PERMS]).toEqual([
            'system:admin',
            'system:org-admin',
            'workspace:provider:read',
            'workspace:datasource:manage',
        ])
    })
})
