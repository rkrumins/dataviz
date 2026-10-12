import { describe, it, expect } from 'vitest'
import { resumePlan } from './resumePlan'

describe('resumePlan', () => {
    it('says a run that died before comparing anything starts over', () => {
        const plan = resumePlan('v3:1757600000000:aggregate:0')
        expect(plan?.phase).toBe('aggregate')
        expect(plan?.detail).toContain('starts the scan again from the beginning')
    })

    it('says a run that died comparing picks up where it stopped', () => {
        expect(resumePlan('v3:1757600000000:reconcile:400000')?.detail)
            .toContain('picks up the comparison where it stopped')
    })

    it('says a run that died writing keeps every edge already written', () => {
        const plan = resumePlan('v3:1757600000000:apply:99')
        expect(plan?.detail).toContain('keeps every aggregated edge already written')
        // …and warns that the bar restarts, which is the thing that reads as
        // the resume not having worked.
        expect(plan?.detail).toContain('starts from zero and climbs back')
    })

    it('promises nothing for a cursor it cannot read', () => {
        // A legacy or malformed cursor starts a fresh run, which is always
        // safe — but promising a pick-up that will not happen is not.
        for (const bad of [null, undefined, '', 'v2:123', 'v3:1:teleporting:0', 'garbage']) {
            expect(resumePlan(bad)).toBeNull()
        }
    })
})
