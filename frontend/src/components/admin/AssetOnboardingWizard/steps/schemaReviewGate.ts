import type { OntologyResolutionResponse } from '@/services/ontologyResolutionService'

/** Gate blockers the wizard shows as a warning instead of a stop. A graph with
 *  only containment edges (pure hierarchies, no data flow) is a legitimate
 *  source: aggregation has nothing to build for it, but onboarding must still
 *  be able to proceed. */
export const WIZARD_WARNING_BLOCKERS = ['no_lineage']

/** Whether a source's gate report lets the wizard proceed past Schema Review:
 *  checked, and blocked by nothing beyond the reasons downgraded above. */
export function canProceedPastGate(
    resolution: OntologyResolutionResponse | null | undefined,
): boolean {
    return !!resolution && resolution.blockingReasons.every(r => WIZARD_WARNING_BLOCKERS.includes(r))
}
