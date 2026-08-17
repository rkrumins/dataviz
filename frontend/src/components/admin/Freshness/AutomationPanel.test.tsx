import { describe, expect, it } from 'vitest'

import { automationWarnings } from './automationCopy'

describe('automationWarnings', () => {
    it('warns that checks are only as fresh as the slow refresh when detect is off', () => {
        const w = automationWarnings(
            { enabled: true, detectors: null },
            { probeEnabled: false },
        )
        expect(w.map(x => x.id)).toContain('detect-off')
        expect(w[0].text).toMatch(/only see data as fresh as/i)
    })

    it('warns when every detector is unchecked', () => {
        const w = automationWarnings(
            { enabled: true, detectors: [] },
            { probeEnabled: true },
        )
        expect(w.map(x => x.id)).toContain('no-detectors')
    })

    it('treats an unset detector list as all-on, not none', () => {
        // null = "all enabled"; [] = "act on nothing". Never truthiness.
        const w = automationWarnings(
            { enabled: true, detectors: null },
            { probeEnabled: true },
        )
        expect(w.map(x => x.id)).not.toContain('no-detectors')
    })

    it('warns when the action cap is zero', () => {
        const w = automationWarnings(
            { enabled: true, detectors: null, maxActionsPerRun: 0 },
            { probeEnabled: true },
        )
        expect(w.map(x => x.id)).toContain('cap-zero')
    })

    it('is silent on a healthy policy', () => {
        expect(automationWarnings(
            { enabled: true, detectors: null, maxActionsPerRun: 10 },
            { probeEnabled: true },
        )).toEqual([])
    })
})
