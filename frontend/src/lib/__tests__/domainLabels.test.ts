/**
 * The stored value and the word a person reads are allowed to differ. What is
 * not allowed is for two surfaces to disagree about the word.
 */
import { describe, expect, it } from 'vitest'

import {
    VIEW_TYPE_LABELS, humaniseKey, signupSourceLabel, viewActionLabel,
    viewTypeLabel, visibilityLabel,
} from '@/lib/domainLabels'

describe('domain labels', () => {
    it('calls a `reference` view a Context View', () => {
        // The single most-drifted label in the product: the column stores a
        // historical key, every surface says "Context View", and Analytics
        // used to render the raw enum.
        expect(viewTypeLabel('reference')).toBe('Context View')
        expect(viewTypeLabel('reference')).not.toMatch(/reference/i)
    })

    it('mirrors the backend seed for allowedViewModes', () => {
        // These four are the option labels seeded in
        // `backend/app/config/features_seed.py` for the `allowedViewModes`
        // flag. A backend test pins the same strings from the other side, so
        // changing one half alone fails a build.
        expect(VIEW_TYPE_LABELS.graph).toBe('Graph')
        expect(VIEW_TYPE_LABELS.hierarchy).toBe('Hierarchy')
        expect(VIEW_TYPE_LABELS.reference).toBe('Context View')
        expect(VIEW_TYPE_LABELS['layered-lineage']).toBe('Layered Lineage')
    })

    it('never leaves a known enum reading as snake_case', () => {
        const knownKeys = [
            ...Object.keys(VIEW_TYPE_LABELS),
            'private', 'workspace', 'enterprise',
            'local_signup', 'sso_jit', 'invite', 'admin_created', 'admin_linked',
            'created', 'updated', 'visibility_changed', 'data_changed',
        ]
        const label = (k: string) =>
            viewTypeLabel(k) !== humaniseKey(k) ? viewTypeLabel(k)
                : visibilityLabel(k) !== humaniseKey(k) ? visibilityLabel(k)
                    : signupSourceLabel(k) !== humaniseKey(k) ? signupSourceLabel(k)
                        : viewActionLabel(k)
        for (const key of knownKeys) {
            expect(label(key), `${key} has no human label`).not.toContain('_')
        }
    })

    it('falls back to title case for a key nobody has named yet', () => {
        // A new enum value must still read as words rather than breaking or
        // rendering raw — the fallback is the safety net, not the plan.
        expect(viewTypeLabel('brand_new_type')).toBe('Brand new type')
        expect(humaniseKey('some-other-key')).toBe('Some other key')
    })
})
