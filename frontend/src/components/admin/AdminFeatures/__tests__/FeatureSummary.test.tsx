/**
 * The summary answers "what can't my users do right now?" — the question the page exists for.
 *
 * These pin the two claims it makes, because both are the kind that rot silently: a miscounted
 * "off" list tells an admin their deployment is less restricted than it is, and a wrong
 * "all enforced" badge is exactly the lie this whole change was written to kill.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FeatureSummary } from '../FeatureSummary'
import type { FeatureDefinition } from '@/services/featuresService'

function flag(over: Partial<FeatureDefinition> & { key: string }): FeatureDefinition {
    return {
        name: over.key,
        description: '',
        category: 'lineage',
        type: 'boolean',
        default: true,
        enforcedServerSide: true,
        ...over,
    } as FeatureDefinition
}

describe('FeatureSummary', () => {
    it('names the features that are off, because that IS the deployment state', () => {
        render(
            <FeatureSummary
                features={[
                    flag({ key: 'traceEnabled', name: 'Lineage trace' }),
                    flag({ key: 'signupEnabled', name: 'Self-registration' }),
                ]}
                values={{ traceEnabled: true, signupEnabled: false }}
            />,
        )
        expect(screen.getByText(/Off for everyone right now/i)).toBeInTheDocument()
        expect(screen.getByText(/Self-registration/)).toBeInTheDocument()
        expect(screen.getByText('1')).toBeInTheDocument()
        expect(screen.getByText(/of 2 on/i)).toBeInTheDocument()
    })

    it('falls back to the DEFAULT when a flag has never been saved', () => {
        // A fresh deployment has no stored values at all. Reading `values[key]` alone would report
        // every flag as off and tell the admin their product was dead.
        render(
            <FeatureSummary
                features={[flag({ key: 'traceEnabled', default: true })]}
                values={{}}
            />,
        )
        expect(screen.getByText('1')).toBeInTheDocument()
        expect(screen.getByText(/of 1 on/i)).toBeInTheDocument()
        expect(screen.queryByText(/Off for everyone/i)).not.toBeInTheDocument()
    })

    it('a list flag counts as ON while anything is selected', () => {
        render(
            <FeatureSummary
                features={[flag({ key: 'allowedViewModes', type: 'string[]', default: ['graph'] })]}
                values={{ allowedViewModes: ['graph', 'hierarchy'] }}
            />,
        )
        expect(screen.getByText('1')).toBeInTheDocument()
        expect(screen.getByText(/of 1 on/i)).toBeInTheDocument()
    })

    it('says every switch is server-enforced when it is', () => {
        render(
            <FeatureSummary
                features={[flag({ key: 'traceEnabled' })]}
                values={{ traceEnabled: true }}
            />,
        )
        expect(screen.getByText(/Every switch is enforced by the server/i)).toBeInTheDocument()
    })

    it('CALLS OUT a decorative switch instead of quietly presenting it as real', () => {
        // The bug, as a test. Eight flags were rendered exactly like the working ones while
        // gating nothing at all; an admin had no way to tell by looking.
        render(
            <FeatureSummary
                features={[
                    flag({ key: 'traceEnabled' }),
                    flag({ key: 'decorative', enforcedServerSide: false }),
                ]}
                values={{ traceEnabled: true, decorative: true }}
            />,
        )
        expect(screen.getByText(/1 switch is not enforced/i)).toBeInTheDocument()
        expect(screen.queryByText(/Every switch is enforced/i)).not.toBeInTheDocument()
    })
})
