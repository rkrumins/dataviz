/**
 * The questions the Ask bar offers to try, in the view's own words — each
 * one that reads the way the view's data flows: data feeds what reads it.
 */
import { describe, expect, it } from 'vitest'

import { askExamples } from '../askExamples'


const name = (type: string, plural?: boolean) => (plural ? `${type}s` : type)

describe('askExamples', () => {
    it('asks what reads the data fed by it, never the other way round', () => {
        const technical = askExamples(['dataset', 'dashboard'], ['PII'], name, 'technical')
        expect(technical[0]).toBe('dashboards fed by datasets within 2 hops')
        const business = askExamples(['dataset', 'dashboard'], ['PII'], name, 'business')
        expect(business[0]).toBe('datasets that feed dashboards')
    })
})
