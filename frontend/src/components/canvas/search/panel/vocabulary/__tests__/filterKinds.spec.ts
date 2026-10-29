/**
 * The one catalog of conditions: every entry starts a condition the
 * builders can hold, what is offered depends on where the conditions
 * stand, and the in-group picker calls a condition what the palette does.
 */
import { describe, expect, it } from 'vitest'

import { LEAF_KINDS } from '../../../builder/leafKinds'
import { RELATION_DEPTH_MAX } from '../../relations'
import { FILTER_CATEGORIES, availableCategories, filterKindById } from '../filterKinds'


const ids = (cats: ReturnType<typeof availableCategories>) => cats.flatMap((c) => c.entries.map((e) => e.id))
const everywhere = { relationDepth: 0, rule: false, canAdvanced: true }


describe('filterKinds — the catalog', () => {
    it('names every entry once', () => {
        const all = FILTER_CATEGORIES.flatMap((c) => c.entries.map((e) => e.id))
        expect(new Set(all).size).toBe(all.length)
    })

    it('starts every added condition as a fresh condition of its kind', () => {
        for (const entry of FILTER_CATEGORIES.flatMap((c) => c.entries)) {
            const a = entry.build!()
            const b = entry.build!()
            expect(a.kind).toBeTruthy()
            expect(a).not.toBe(b)        // never a shared object to mutate
            expect(a).toEqual(b)
        }
    })

    it('finds an entry by its id', () => {
        expect(filterKindById('no-downstream')?.label).toBe('No downstream lineage')
        expect(filterKindById('nope')).toBeUndefined()
    })
})


describe('filterKinds — what can be added where', () => {
    it('offers everything at the top of a full query', () => {
        expect(ids(availableCategories(everywhere))).toEqual(
            FILTER_CATEGORIES.flatMap((c) => c.entries.map((e) => e.id)))
    })

    it('keeps routes out of a relationship\'s condition, and lets "inside a container" in', () => {
        const inside = ids(availableCategories({ ...everywhere, relationDepth: 1 }))
        for (const route of ['path', 'within-hops']) expect(inside).not.toContain(route)
        // The relative's own test: in that container, or below it.
        for (const scope of ['root-in-view', 'inside-subtree', 'inside-named']) expect(inside).toContain(scope)
        expect(inside).toContain('rel-parent')
    })

    it('stops relationships nesting deeper than the server allows', () => {
        const deepest = ids(availableCategories({ ...everywhere, relationDepth: RELATION_DEPTH_MAX }))
        expect(deepest.some((id) => id.startsWith('rel-'))).toBe(false)
    })

    it('gives a display rule no routes: the server refuses them there', () => {
        const rule = ids(availableCategories({ ...everywhere, rule: true }))
        expect(rule).not.toContain('path')
        expect(rule).not.toContain('within-hops')
        // An edge count tests the entity itself.
        expect(rule).toContain('degree')
    })

    it('keeps routes out of a connection\'s ends', () => {
        const end = ids(availableCategories({ ...everywhere, end: true }))
        for (const route of ['path', 'within-hops']) expect(end).not.toContain(route)
    })

    it('drops a category left with nothing in it', () => {
        const cats = availableCategories({ ...everywhere, relationDepth: RELATION_DEPTH_MAX, rule: true })
        expect(cats.every((c) => c.entries.length > 0)).toBe(true)
    })
})


describe('filterKinds — one name per condition', () => {
    it('calls a condition the same in the in-group picker as in the palette', () => {
        const label = (kind: string) => LEAF_KINDS.find((m) => m.kind === kind)?.label
        expect(label('isLeaf')).toBe('No downstream lineage')
        expect(label('isRoot')).toBe('No upstream lineage')
        expect(label('isOrphan')).toBe('No lineage edges')
        expect(label('hasIncoming')).toBe('Has upstream lineage')
        expect(label('entityType')).toBe('Entity type is…')
        expect(label('path')).toBe('Paths from A to B')
    })
})
