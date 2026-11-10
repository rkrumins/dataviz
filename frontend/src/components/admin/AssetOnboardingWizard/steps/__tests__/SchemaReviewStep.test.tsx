/**
 * A graph with only containment edges (pure hierarchies, no data flow) has no
 * lineage relationship to classify. The gate reports that as ``no_lineage``
 * (it blocks aggregation server-side), but onboarding such a source is
 * legitimate — so Schema Review must show it as a warning, not stop the
 * wizard. Any other blocker still stops it.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/features/ontology/hooks/useOntologyMutations', () => ({
    useOntologyMutations: () => ({ invalidateAll: vi.fn() }),
}))

import type { CatalogItemResponse } from '@/services/catalogService'
import type { OntologyResolutionResponse } from '@/services/ontologyResolutionService'
import type { OnboardingFormData } from '../../AssetOnboardingWizard'
import { SchemaReviewStep, type SchemaReviewStatusMap } from '../SchemaReviewStep'
import { canProceedPastGate } from '../schemaReviewGate'

function report(overrides: Partial<OntologyResolutionResponse> = {}): OntologyResolutionResponse {
    return {
        resolved: true,
        ontologyId: 'ont-1',
        ontologyVersion: 1,
        ontologyIsPublished: false,
        missingEntityTypes: [],
        missingEdgeTypes: [],
        unclassifiedRelationships: [],
        hasLineage: true,
        hasContainment: true,
        hierarchyWarnings: [],
        advisoryWarnings: [],
        blockingReasons: [],
        coveragePercent: 100,
        fingerprint: null,
        ...overrides,
    }
}

/** What the gate returns for a containment-only graph. */
const CONTAINMENT_ONLY = report({ resolved: false, hasLineage: false, blockingReasons: ['no_lineage'] })

describe('canProceedPastGate', () => {
    it('lets a containment-only source through', () => {
        expect(canProceedPastGate(CONTAINMENT_ONLY)).toBe(true)
    })

    it('lets a resolved source through', () => {
        expect(canProceedPastGate(report())).toBe(true)
    })

    it('still stops on any other blocker', () => {
        expect(canProceedPastGate(report({ resolved: false, blockingReasons: ['no_lineage', 'ontology_missing'] }))).toBe(false)
    })

    it('stops until the source has been checked', () => {
        expect(canProceedPastGate(null)).toBe(false)
        expect(canProceedPastGate(undefined)).toBe(false)
    })
})

describe('SchemaReviewStep with a containment-only source', () => {
    it('shows no lineage as a warning, not a block', () => {
        const item = { id: 'cat-1', name: 'Org hierarchy', sourceIdentifier: 'org' } as CatalogItemResponse
        const formData = {
            ontologySelections: { 'cat-1': { ontologyId: 'ont-1', suggestedOntology: null, coverageStats: null } },
        } as unknown as OnboardingFormData
        const statusMap: SchemaReviewStatusMap = {
            'cat-1': {
                ontologyId: 'ont-1',
                resolution: CONTAINMENT_ONLY,
                classifications: {},
                loading: false,
                saving: false,
                error: null,
            },
        }

        render(
            <SchemaReviewStep
                formData={formData}
                updateFormData={vi.fn()}
                catalogItems={[item]}
                providerId="prov-1"
                ontologyNames={{ 'ont-1': 'Org ontology' }}
                statusMap={statusMap}
                onStatusChange={vi.fn()}
            />,
        )

        expect(screen.queryByText('Blocked')).toBeNull()
        expect(screen.queryByText(/Blocking ·/)).toBeNull()
        expect(screen.getByText(/Ready · 1 advisory/)).toBeTruthy()
        expect(screen.getByText('No lineage relationship')).toBeTruthy()
        expect(screen.getByText('No relationship is flagged as Lineage')).toBeTruthy()
        expect(screen.getByText(/^Ready to submit\. A source has no lineage relationship/)).toBeTruthy()
    })
})
