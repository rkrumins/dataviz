/**
 * A zero result must describe the search that RAN.
 *
 * The panel used to assert "searched every entity in this view, including
 * containers you haven't opened" no matter what — while the backend was
 * reporting, in the very same response, that it had searched two entity
 * types out of seven, or that it had discarded every root it was given.
 * These tests exist to keep that sentence honest.
 */
import { describe, expect, it } from 'vitest'

import type { ScopeDiagnostics } from '@/types/search'

import { summariseScope } from '../summariseScope'


const FIELDS = 'names, descriptions, tags and property values'

function diag(over: Partial<ScopeDiagnostics> = {}): ScopeDiagnostics {
    return {
        effectiveRootUrns: ['urn:root'],
        effectiveMaxDepth: 10,
        droppedRootUrns: [],
        lineageEdgeTypes: [],
        containmentEdgeTypes: ['CONTAINS'],
        notes: [],
        ...over,
    } as ScopeDiagnostics
}


describe('summariseScope', () => {
    it('keeps the full claim when the search really did cover the view', () => {
        const s = summariseScope(FIELDS, diag(), false)
        expect(s.sentence).toContain('every entity in this view')
        expect(s.caveat).toBeUndefined()
    })

    it('never claims full coverage with no backend', () => {
        const s = summariseScope(FIELDS, null, true)
        expect(s.sentence).not.toContain('every entity in this view')
        expect(s.sentence).toContain('already loaded on this canvas')
        expect(s.caveat).toMatch(/haven.t opened were not searched/)
    })

    it('names the entity-type filter that suppressed the answer', () => {
        // The reported case: a view set to 2 visible types can never
        // return a schema field, and said nothing about it.
        const s = summariseScope(FIELDS, diag({
            effectiveEntityTypes: ['Domain', 'DataPlatform'],
        }), false)
        expect(s.sentence).not.toContain('every entity in this view')
        expect(s.caveat).toContain('Domain and DataPlatform')
        expect(s.caveat).toMatch(/hides other entity types/)
        expect(s.canWiden).toBe(true)
    })

    it('says nothing was searched when the boundary could not be resolved', () => {
        const s = summariseScope(FIELDS, diag({
            effectiveRootUrns: [],
            droppedRootUrns: ['urn:hostile'],
        }), false)
        expect(s.caveat).toMatch(/boundary couldn.t be resolved/)
        expect(s.sentence).not.toContain('every entity in this view')
    })

    it('flags a data source with no containment edges', () => {
        // The scope chain compiles to nothing at all in this case, so
        // "inside this view" was never evaluated.
        const s = summariseScope(FIELDS, diag({
            containmentEdgeTypes: [],
        }), false)
        expect(s.caveat).toMatch(/no containment relationships/)
    })

    it('reports ignored root hints without retracting the coverage claim', () => {
        const s = summariseScope(FIELDS, diag({
            droppedRootUrns: ['urn:a', 'urn:b'],
        }), false)
        // The search DID run over the view — the hint was just ignored.
        expect(s.sentence).toContain('every entity in this view')
        expect(s.caveat).toContain('2 containers')
    })

    it('does not overstate when the server never answered', () => {
        const s = summariseScope(FIELDS, null, false)
        expect(s.sentence).not.toContain('every entity in this view')
        expect(s.caveat).toBeUndefined()
    })
})
