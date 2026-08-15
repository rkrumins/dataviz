import { describe, expect, it } from 'vitest'
import { checkNowSuccessMessage } from './OverlayIntegrity'
import type { ReconcileRunResult } from '@/services/freshnessService'

describe('checkNowSuccessMessage', () => {
    it('never claims Checked 0 sources', () => {
        const res: ReconcileRunResult = {
            skipped: false,
            findings: [],
            run: {
                id: 'r', mode: 'manual', scanned: 0, skipped: 0, seeded: 0,
                findings: 0, actions: 0, errors: 0, byReason: {}, bySkip: {},
                startedAt: new Date().toISOString(),
            },
        }
        expect(checkNowSuccessMessage(res)).toBe('No sources in the reconcile set yet.')
        expect(checkNowSuccessMessage(res)).not.toMatch(/Checked 0/)
    })

    it('says all clear when sources were checked and none rebuilt', () => {
        const res: ReconcileRunResult = {
            skipped: false,
            findings: [],
            run: {
                id: 'r', mode: 'manual', scanned: 12, skipped: 0, seeded: 0,
                findings: 0, actions: 0, errors: 0, byReason: {}, bySkip: {},
                startedAt: new Date().toISOString(),
            },
        }
        expect(checkNowSuccessMessage(res)).toBe('Checked 12 sources — all clear.')
    })

    it('names rebuilds when the sweep acted', () => {
        const res: ReconcileRunResult = {
            skipped: false,
            findings: [],
            run: {
                id: 'r', mode: 'manual', scanned: 12, skipped: 0, seeded: 0,
                findings: 2, actions: 2, errors: 0, byReason: {}, bySkip: {},
                startedAt: new Date().toISOString(),
            },
        }
        expect(checkNowSuccessMessage(res)).toBe('Checked 12 sources — 2 reconciled.')
    })
})
