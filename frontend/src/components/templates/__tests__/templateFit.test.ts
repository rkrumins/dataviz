/**
 * Layout templates and the data a view reads. Applied, a template comes in as
 * authored: the hints the data declares in its spelling, the rest dropped — or
 * all kept when the data's types are not known — and rules that could never
 * match dropped rather than left to match everything. Asked for, suggestions
 * fill the layers nothing fills yet: by name, else by the hierarchy's levels.
 */
import { describe, expect, it } from 'vitest'
import type { ViewLayerConfig } from '@/types/schema'
import { fitTargetOf, fitTemplate, normaliseTypeName, suggestFills } from '../templateFit'

const LAYERS: ViewLayerConfig[] = [
    { id: 'a', name: 'Domains', entityTypes: ['domain', 'bounded-context'], order: 0, color: '#123456' },
    {
        id: 'b', name: 'Products', entityTypes: ['DATASET', 'dataset', 'table'], order: 1,
        rules: [
            { id: 'r1', entityTypes: ['table'], priority: 1 },              // every type unknown → dropped
            { id: 'r2', entityTypes: ['dataset', 'table'], priority: 1 },   // narrowed to what exists
            { id: 'r3', tags: ['pii'], priority: 1 },                       // no types: kept as is
        ],
        logicalNodes: [{
            id: 'g', name: 'Group', type: 'group',
            children: [{ id: 'c', name: 'Child', type: 'group', rules: [{ id: 'r4', entityTypes: ['table'], priority: 1 }] }],
        }],
    },
    { id: 'c', name: 'By hand', entityTypes: [], order: 2 },
]

/** The built-in "Analytics Pipeline" (backend/app/db/seed_templates.py): stages, not containment. */
const ANALYTICS_PIPELINE: ViewLayerConfig[] = [
    { id: 'raw', name: 'Raw', entityTypes: ['raw', 'source', 'extract'], order: 0 },
    { id: 'curated', name: 'Curated', entityTypes: ['curated', 'clean', 'validated'], order: 1 },
    { id: 'aggregated', name: 'Aggregated', entityTypes: ['aggregated', 'summary', 'metric'], order: 2 },
    { id: 'dashboard', name: 'Dashboard', entityTypes: ['dashboard', 'report', 'visualization'], order: 3 },
]

/** Domain contains System contains Dataset. */
const DSD = [
    { id: 'Domain', name: 'Domain', pluralName: 'Domains', hierarchy: { level: 0, canContain: ['System'] } },
    { id: 'System', name: 'System', pluralName: 'Systems', hierarchy: { level: 1, canContain: ['Dataset'] } },
    { id: 'Dataset', name: 'Dataset', pluralName: 'Datasets', hierarchy: { level: 2, canContain: [] } },
]
const DSD_TARGET = fitTargetOf({ entityTypes: DSD, rootEntityTypes: ['Domain'] })

const layer = (id: string, name: string, entityTypes: string[] = [], over: Partial<ViewLayerConfig> = {}): ViewLayerConfig =>
    ({ id, name, entityTypes, order: 0, ...over })

describe('fitTemplate — a template applied as authored', () => {
    it("keeps the hints the data declares, in its spelling, once, and drops the rest", () => {
        const fit = fitTemplate(LAYERS, ['Dataset', 'System'])
        expect(fit.layers.map(l => l.entityTypes)).toEqual([[], ['Dataset'], []])
    })

    it('never fills a layer by name or by level', () => {
        const fit = fitTemplate(ANALYTICS_PIPELINE, DSD_TARGET)
        expect(fit.layers.map(l => l.name)).toEqual(['Raw', 'Curated', 'Aggregated', 'Dashboard'])
        expect(fit.layers.map(l => l.entityTypes)).toEqual([[], [], [], []])
        // A plural is not the type: matching by name is a suggestion, not the template.
        expect(fitTemplate([layer('d', 'D', ['dashboards'])], ['Dashboard']).layers[0].entityTypes).toEqual([])
    })

    it.each([['not known', null], ['an empty ontology', []], ['no entity types', { types: [] }]] as const)(
        'keeps every hint as written when the data declares no types (%s)',
        (_, target) => {
            const fit = fitTemplate(LAYERS, target)
            expect(fit.layers.map(l => l.entityTypes)).toEqual([['domain', 'bounded-context'], ['DATASET', 'dataset', 'table'], []])
            expect(fit.layers[1].rules).toEqual(LAYERS[1].rules)
        },
    )

    it('drops a rule that could only ever match unknown types, at any depth', () => {
        const [, products] = fitTemplate(LAYERS, ['Dataset']).layers
        expect(products.rules).toEqual([
            { id: 'r2', entityTypes: ['Dataset'], priority: 1 },
            { id: 'r3', tags: ['pii'], priority: 1 },
        ])
        expect(products.logicalNodes?.[0].children?.[0].rules).toEqual([])
    })

    it('keeps every layer and field, mints fresh ids and renumbers the order', () => {
        const fit = fitTemplate(LAYERS, ['Dataset'])
        expect(fit.layers.map(l => l.name)).toEqual(['Domains', 'Products', 'By hand'])
        expect(fit.layers[0].color).toBe('#123456')
        expect(fit.layers.map(l => l.order)).toEqual([0, 1, 2])
        expect(fit.layers.map(l => l.id)).not.toContain('a')
        expect(new Set(fit.layers.map(l => l.id)).size).toBe(3)
    })

    it('remembers the template layer each column came from, for its later versions', () => {
        const fit = fitTemplate(LAYERS, null)
        expect(fit.layers.map(l => l.templateLayerId)).toEqual(LAYERS.map(l => l.id))
    })
})

describe('suggestFills — by name', () => {
    it("matches a hint to the data's types, ignoring case, separators and plurals", () => {
        const layers = [layer('a', 'A'), layer('b', 'B'), layer('c', 'C'), layer('d', 'D')]
        const hints: Record<string, string[]> = { a: ['DATA_PRODUCTS'], b: ['dashboards'], c: ['data-base'], d: ['business categories'] }
        const suggested = suggestFills(layers, { types: [{ id: 'dataProduct' }, { id: 'Dashboard' }, { id: 'Databases' }, { id: 'BusinessCategory' }] },
            l => hints[l.id])
        expect(suggested).toEqual({
            a: { types: ['dataProduct'], by: 'name' }, b: { types: ['Dashboard'], by: 'name' },
            c: { types: ['Databases'], by: 'name' }, d: { types: ['BusinessCategory'], by: 'name' },
        })
    })

    it("reads the layer's own name, and a type's name or plural name", () => {
        const suggested = suggestFills([layer('r', 'Reports')], { types: [{ id: 'rpt_v2', name: 'Report', pluralName: 'Reports' }] })
        expect(suggested).toEqual({ r: { types: ['rpt_v2'], by: 'name' } })
    })
})

describe('suggestFills — by level', () => {
    it('fills the built-in Analytics Pipeline from a Domain / System / Dataset hierarchy, in order', () => {
        const applied = fitTemplate(ANALYTICS_PIPELINE, DSD_TARGET).layers
        const hints = new Map(ANALYTICS_PIPELINE.map(l => [l.id, l.entityTypes]))
        const suggested = suggestFills(applied, DSD_TARGET, l => hints.get(l.templateLayerId!) ?? [])
        // The stages take the levels coarsest first; the one past the last level gets nothing.
        expect(applied.map(l => suggested[l.id] ?? null)).toEqual([
            { types: ['Domain'], by: 'level' }, { types: ['System'], by: 'level' }, { types: ['Dataset'], by: 'level' }, null,
        ])
    })

    it('fills only the levels between the layers already filled around it', () => {
        const suggested = suggestFills([
            layer('top', 'Top', ['Domain']), layer('mid', 'Middle'), layer('leaf', 'Leaves', ['Dataset']), layer('after', 'After'),
        ], DSD_TARGET)
        expect(suggested).toEqual({ mid: { types: ['System'], by: 'level' } })
    })

    it('never suggests a type another layer holds', () => {
        expect(suggestFills([layer('x', 'X'), layer('d', 'Domains', ['Domain'])], DSD_TARGET)).toEqual({})
        expect(suggestFills([layer('d', 'Domain', ['Domain']), layer('y', 'Domains')], DSD_TARGET))
            .toEqual({ y: { types: ['System'], by: 'level' } })
    })

    it('leaves alone a layer its rules or its entity fill', () => {
        const suggested = suggestFills([
            layer('a', 'Tagged', [], { rules: [{ id: 'r', tags: ['pii'], priority: 1 }] }),
            layer('b', 'Finance', [], { anchorUrn: 'urn:finance' }),
            layer('c', 'Next'),
        ], DSD_TARGET)
        expect(suggested).toEqual({ c: { types: ['Domain'], by: 'level' } })
    })

    it('does not suggest by level from a flat ontology, which has no order to follow', () => {
        const flat = fitTargetOf({ entityTypes: DSD.map(t => ({ ...t, hierarchy: { level: 0, canContain: [] } })) })
        expect(suggestFills([layer('a', 'Raw'), layer('b', 'Curated')], flat)).toEqual({})
    })

    it('suggests nothing when the data declares no types', () => {
        expect(suggestFills([layer('a', 'Domains')], null)).toEqual({})
        expect(suggestFills([layer('a', 'Domains')], { types: [] })).toEqual({})
    })
})

describe('normaliseTypeName', () => {
    it.each([
        ['Data_Products', 'dataproduct'], ['data-product', 'dataproduct'], ['Categories', 'category'],
        ['Classes', 'class'], ['boxes', 'box'], ['Databases', 'database'], ['Status', 'status'],
        ['Analysis', 'analysis'], ['Process', 'process'],
    ])('%s → %s', (input, out) => {
        expect(normaliseTypeName(input)).toBe(out)
    })
})

describe('fitTargetOf', () => {
    it("reads the hierarchy's levels from its roots, coarsest first", () => {
        expect(DSD_TARGET?.levels).toEqual([['Domain'], ['System'], ['Dataset']])
    })

    it('knows nothing of a data source without entity types', () => {
        expect(fitTargetOf({ entityTypes: [] })).toBeNull()
    })
})
