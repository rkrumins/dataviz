/**
 * The palette slot a class keeps on every Analytics chart.
 *
 * Colour follows the entity. Where a page draws the same classes twice — a
 * stacked area and a share bar — each chart ordering its own way would paint
 * one class two colours, so the slot is decided here, once.
 */
import type { RunOrigin } from '@/services/analyticsService'

/** Graph stores and catalogues. A type not listed here takes the last slot;
 *  `unknown` is the residual and takes none. */
const PROVIDER_SLOT: Record<string, number> = { falkordb: 0, neo4j: 1, datahub: 2, spanner: 3, mock: 4 }

export function providerSlot(key: string): number | undefined {
    if (key === 'unknown') return undefined
    return PROVIDER_SLOT[key] ?? 5
}

/** Who started a run. `other` is the residual and takes none. */
export const RUN_ORIGIN_SLOT: Record<RunOrigin, number | undefined> = {
    automatic: 0, byHand: 1, onboarding: 2, other: undefined,
}
