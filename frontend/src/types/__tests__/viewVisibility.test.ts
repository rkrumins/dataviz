/**
 * The shared tier definitions.
 *
 * These matter more than they look: the labels and descriptions here are
 * what every selector, badge and confirmation dialog renders, and they
 * replaced five hand-written copies that had already drifted apart. The
 * ladder order backs the "is this widening?" check that decides whether a
 * bulk change gets a confirmation step.
 */
import { describe, expect, it } from 'vitest'

import {
    DEFAULT_VISIBILITY,
    VIEW_VISIBILITY,
    VISIBILITY_META,
    VISIBILITY_ORDER,
    grantedByCopy,
    isViewVisibility,
    isWidening,
    visibilityMeta,
} from '../viewVisibility'

describe('tier ladder', () => {
    it('runs narrowest to widest', () => {
        expect([...VISIBILITY_ORDER]).toEqual([
            'private', 'workspace', 'enterprise', 'public',
        ])
    })

    it('describes every tier', () => {
        for (const tier of VISIBILITY_ORDER) {
            const meta = VISIBILITY_META[tier]
            expect(meta.label).toBeTruthy()
            expect(meta.description).toBeTruthy()
            expect(meta.reach).toBeTruthy()
            expect(meta.icon).toBeTruthy()
        }
    })

    it('gives each tier a distinct icon', () => {
        // Two tiers sharing a glyph makes the badge unreadable at a glance,
        // which is the badge's whole job.
        const icons = VISIBILITY_ORDER.map(t => VISIBILITY_META[t].icon)
        expect(new Set(icons).size).toBe(icons.length)
    })

    it('defaults to the narrowest tier', () => {
        expect(DEFAULT_VISIBILITY).toBe(VIEW_VISIBILITY.PRIVATE)
        expect(VISIBILITY_ORDER[0]).toBe(DEFAULT_VISIBILITY)
    })
})

describe('isWidening', () => {
    it('is true only when moving up the ladder', () => {
        expect(isWidening('private', 'workspace')).toBe(true)
        expect(isWidening('private', 'public')).toBe(true)
        expect(isWidening('workspace', 'enterprise')).toBe(true)
        expect(isWidening('enterprise', 'public')).toBe(true)
    })

    it('is false for narrowing and for no-ops', () => {
        expect(isWidening('public', 'private')).toBe(false)
        expect(isWidening('enterprise', 'workspace')).toBe(false)
        expect(isWidening('workspace', 'workspace')).toBe(false)
    })

    it('treats an unknown value as the narrowest tier', () => {
        // A legacy or unrecognised tier must not read as "already wide",
        // which would skip the confirmation on a real widening.
        expect(isWidening('nonsense', 'public')).toBe(true)
        expect(isWidening('private', 'nonsense')).toBe(false)
    })
})

describe('tolerating values off the wire', () => {
    it('recognises only real tiers', () => {
        expect(isViewVisibility('public')).toBe(true)
        expect(isViewVisibility('everyone')).toBe(false)
        expect(isViewVisibility(undefined)).toBe(false)
        expect(isViewVisibility(null)).toBe(false)
    })

    it('always returns renderable meta', () => {
        // The badge has to draw something even for a tier this build has
        // never heard of — a newer server, a legacy row.
        expect(visibilityMeta('public').label).toBe('Public')
        expect(visibilityMeta('who-knows').label).toBe('Private')
        expect(visibilityMeta(undefined).label).toBe('Private')
    })
})

describe('grantedBy provenance', () => {
    it('explains each reason the backend can return', () => {
        for (const reason of [
            'creator', 'grant', 'workspace-admin', 'system-admin',
            'tier:workspace', 'tier:enterprise', 'tier:public',
        ]) {
            expect(grantedByCopy(reason)).toBeTruthy()
        }
    })

    it('returns null rather than a placeholder when absent', () => {
        // Callers fall back to the tier label; a string like "unknown"
        // would render as a tooltip that says nothing.
        expect(grantedByCopy(undefined)).toBeNull()
        expect(grantedByCopy(null)).toBeNull()
        expect(grantedByCopy('something-new')).toBeNull()
    })
})
