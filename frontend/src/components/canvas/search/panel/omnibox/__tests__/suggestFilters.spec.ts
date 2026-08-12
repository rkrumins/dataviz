import { describe, expect, it } from 'vitest'

import {
    matchQuality,
    suggestFilters,
    type SuggestInput,
    type SuggestSection,
} from '../suggestFilters'


const BASE: SuggestInput = {
    query: '',
    entityTypes: ['dataset', 'PII_Report', 'column'],
    tagValues: ['PII', 'PII_Reviewed', 'deprecated'],
    propertyKeys: ['classification', 'pii_flag', 'owner'],
    valueSamples: [
        { key: 'classification', value: 'PII', lc: 'pii' },
        { key: 'classification', value: 'Public', lc: 'public' },
        { key: 'owner', value: 'analytics', lc: 'analytics' },
    ],
    layers: [{ value: 'gold', label: 'Gold' }],
}

const flat = (sections: SuggestSection[]) => sections.flatMap((s) => s.items)
const ids = (sections: SuggestSection[]) => flat(sections).map((i) => i.id)


describe('matchQuality', () => {
    it('ranks exact over prefix over word over substring', () => {
        expect(matchQuality('PII', 'pii')).toBe('exact')
        expect(matchQuality('PII_Reviewed', 'pii')).toBe('prefix')
        expect(matchQuality('data_pii_flag', 'pii')).toBe('word')
        expect(matchQuality('happier', 'pi')).toBe('substring')
        expect(matchQuality('owner', 'pii')).toBe('none')
    })

    it('treats camelCase humps as word boundaries', () => {
        // Without this, `hasPiiFlag` would only ever be a weak
        // substring match for "pii" and would sink below noise.
        expect(matchQuality('hasPiiFlag', 'pii')).toBe('word')
        expect(matchQuality('maxRowCount', 'row')).toBe('word')
    })
})


describe('suggestFilters', () => {
    it('reaches every facet from one token', () => {
        const sections = suggestFilters({ ...BASE, query: 'PII' })
        const groups = new Set(sections.map((s) => s.group))
        // The whole point: a business user types one word and gets the
        // tag, the property value, the property key, the entity type
        // and the name search together, instead of having to know
        // which facet to go hunting in.
        expect(groups).toContain('tag')
        expect(groups).toContain('propertyValue')
        expect(groups).toContain('propertyKey')
        expect(groups).toContain('type')
        expect(groups).toContain('text')
    })

    it('leads with the exact tag match', () => {
        const sections = suggestFilters({ ...BASE, query: 'PII' })
        expect(sections[0].group).toBe('tag')
        expect(sections[0].items[0].id).toBe('tag:PII')
    })

    it('prefers the exactly-matching tag over the longer one', () => {
        const sections = suggestFilters({ ...BASE, query: 'PII' })
        const tags = sections.find((s) => s.group === 'tag')!.items
        expect(tags.map((i) => i.id))
            .toEqual(['tag:PII', 'tag:PII_Reviewed'])
    })

    it('offers a property-value filter carrying the right predicate', () => {
        const sections = suggestFilters({ ...BASE, query: 'PII' })
        const hit = flat(sections).find((i) => i.id === 'value:classification:PII')
        expect(hit).toBeDefined()
        expect(hit!.predicate).toMatchObject({
            kind: 'property', key: 'classification', op: 'eq', value: 'PII',
        })
        expect(hit!.complete).toBe(true)
    })

    it('always offers name-contains, even when nothing else matches', () => {
        const sections = suggestFilters({ ...BASE, query: 'zzzz-nothing' })
        const names = flat(sections).filter((i) => i.id === 'text:name')
        expect(names).toHaveLength(1)
        expect(names[0].predicate).toMatchObject({
            kind: 'text', value: 'zzzz-nothing', target: 'name',
        })
    })

    it('survives discovery being empty', () => {
        // Discovery is a separate request that can fail or still be in
        // flight. The omnibox must never be a dead end because of it.
        const sections = suggestFilters({
            query: 'orders', entityTypes: [], tagValues: [],
            propertyKeys: [], valueSamples: [], layers: [],
        })
        expect(ids(sections)).toContain('text:name')
    })

    it('offers the typed literal against a key even when unsampled', () => {
        // Samples are 20 values per key — absence is not evidence, so
        // matching a key must not gate the value on the sample.
        const sections = suggestFilters({ ...BASE, query: 'owner' })
        const hit = flat(sections).find((i) => i.id === 'keyeq:owner')
        expect(hit!.predicate).toMatchObject({
            kind: 'property', key: 'owner', op: 'eq', value: 'owner',
        })
    })

    it('caps how many values one key can contribute', () => {
        const noisy = Array.from({ length: 10 }, (_, i) => ({
            key: 'classification', value: `PII-${i}`, lc: `pii-${i}`,
        }))
        const sections = suggestFilters({
            ...BASE, valueSamples: noisy, query: 'PII',
        })
        const values = sections.find((s) => s.group === 'propertyValue')
        expect(values!.items.length).toBeLessThanOrEqual(2)
    })

    it('labels sampled values as sampled', () => {
        const sections = suggestFilters({ ...BASE, query: 'PII' })
        const values = sections.find((s) => s.group === 'propertyValue')
        expect(values!.note).toMatch(/sampled/i)
    })

    it('narrows to one facet when a browse tile is active', () => {
        const sections = suggestFilters({
            ...BASE, query: 'PII', activeGroup: 'tag',
        })
        expect(sections.map((s) => s.group)).toEqual(['tag'])
    })

    it('finds lineage-shape filters by what a user would call them', () => {
        const sections = suggestFilters({ ...BASE, query: 'dead end' })
        const hit = flat(sections).find((i) => i.id.startsWith('shape:'))
        expect(hit!.predicate).toMatchObject({ kind: 'isLeaf' })
    })

    it('shows real data, not an abstract menu, before anything is typed', () => {
        const sections = suggestFilters(BASE)
        expect(sections).toHaveLength(1)
        expect(sections[0].group).toBe('start')
        // Every entry has to be a working query against this view.
        expect(ids(sections)).toContain('tag:PII')
        expect(ids(sections)).toContain('type:dataset')
    })

    it('still offers something when the view has no discovery data', () => {
        // Discovery can be empty or still loading. The lineage-shape
        // filters need no discovery at all, so the cold-start list is
        // never blank.
        const sections = suggestFilters({
            query: '', entityTypes: [], tagValues: [],
            propertyKeys: [], valueSamples: [], layers: [],
        })
        expect(ids(sections)).toEqual(['shape:isLeaf'])
    })

    it('lists a whole facet when a browse tile is picked with no query', () => {
        const sections = suggestFilters({ ...BASE, activeGroup: 'propertyKey' })
        expect(ids(sections)).toEqual(
            expect.arrayContaining(['key:classification', 'key:pii_flag', 'key:owner']),
        )
    })

    it('marks a value-less filter as incomplete so the caller can focus it', () => {
        const sections = suggestFilters({ ...BASE, activeGroup: 'text' })
        const nameRow = flat(sections).find((i) => i.id === 'text:name')
        expect(nameRow!.complete).toBe(false)
    })
})
