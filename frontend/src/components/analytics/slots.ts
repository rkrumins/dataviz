/**
 * The palette slot a class keeps on every Analytics chart.
 *
 * Colour follows the entity. Where a page draws the same classes twice — a
 * stacked area and a share bar — each chart ordering its own way would paint
 * one class two colours, so the slot is decided here, once.
 */
import { humaniseKey } from '@/lib/domainLabels'
import type { RunOrigin } from '@/services/analyticsService'
import {
    CLASSIFICATION_LABEL, TRUST_LABEL, type Classification, type TrustStatus,
} from '@/services/dataSourceMetadataService'

/** Graph stores and catalogues. A type not listed here takes the last slot;
 *  `unknown` is the residual and takes none. */
const PROVIDER_SLOT: Record<string, number> = { falkordb: 0, neo4j: 1, datahub: 2, spanner: 3, mock: 4 }

export function providerSlot(key: string): number | undefined {
    if (key === 'unknown') return undefined
    return PROVIDER_SLOT[key] ?? 5
}

/** A source's trust status, and its classification. `none` — not marked —
 *  is the residual and takes none, so the marked classes read as the signal. */
const TRUST_SLOT: Record<string, number> = { certified: 2, in_review: 1, deprecated: 4 }
const CLASSIFICATION_SLOT: Record<string, number> = { public: 0, internal: 5, confidential: 3, restricted: 4 }

export const trustSlot = (key: string): number | undefined => TRUST_SLOT[key]
export const classificationSlot = (key: string): number | undefined => CLASSIFICATION_SLOT[key]

/** And what they are called — the words the source's own details use. */
export const trustLabel = (key: string): string =>
    key === 'none' ? 'Not marked' : TRUST_LABEL[key as TrustStatus] ?? humaniseKey(key)
export const classificationLabel = (key: string): string =>
    key === 'none' ? 'Not marked' : CLASSIFICATION_LABEL[key as Classification] ?? humaniseKey(key)

/** Who started a run. `other` is the residual and takes none. */
export const RUN_ORIGIN_SLOT: Record<RunOrigin, number | undefined> = {
    automatic: 0, byHand: 1, onboarding: 2, other: undefined,
}
