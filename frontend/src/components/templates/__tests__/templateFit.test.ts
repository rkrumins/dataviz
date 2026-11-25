/**
 * Fitting a layout template to a view's data: each layer is filled with the
 * data's own types — by a hint's name, else by its place in the hierarchy —
 * or left for the person to fill. No layer is dropped, nothing is claimed
 * when the data's types are not known, rules that could never match are
 * dropped rather than left to match everything, and the new view owns fresh
 * layer ids.
 */
import { describe, expect, it } from 'vitest'
import type { ViewLayerConfig } from '@/types/schema'
import { fitOutcome, fitTargetOf, fitTemplate, normaliseTypeName, type TemplateFit } from '../templateFit'

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

const typesOf = (fit: TemplateFit) => fit.layers.map(l => l.entityTypes)
const howOf = (fit: TemplateFit) => fit.layers.map(l => fit.fills[l.id].by)

describe('fitTemplate — by name', () => {
    it("resolves hints to the data's own spelling, ignoring case, separators and plurals", () => {
        const fit = fitTemplate([
            { id: 'a', name: 'A', entityTypes: ['DATA_PRODUCTS'], order: 0 },
            { id: 'b', name: 'B', entityTypes: ['dashboards'], order: 1 },
            { id: 'c', name: 'C', entityTypes: ['data-base'], order: 2 },
            { id: 'd', name: 'D', entityTypes: ['business categories'], order: 3 },
        ], { types: [{ id: 'dataProduct' }, { id: 'Dashboard' }, { id: 'Databases' }, { id: 'BusinessCategory' }] })
        expect(typesOf(fit)).toEqual([['dataProduct'], ['Dashboard'], ['Databases'], ['BusinessCategory']])
        expect(howOf(fit)).toEqual(['name', 'name', 'name', 'name'])
    })

    it("matches a hint to a type's name or plural name when its id says nothing", () => {
        const fit = fitTemplate(
            [{ id: 'a', name: 'Reports', entityTypes: ['report'], order: 0 }],
            { types: [{ id: 'rpt_v2', name: 'Report', pluralName: 'Reports' }] },
        )
        expect(typesOf(fit)).toEqual([['rpt_v2']])
    })

    it('fits a template written in the data\'s own vocabulary exactly, by name alone', () => {
        const fit = fitTemplate([
            { id: 'd', name: 'Domains', entityTypes: ['domain'], order: 0 },
            { id: 's', name: 'Systems', entityTypes: ['system'], order: 1 },
            { id: 't', name: 'Datasets', entityTypes: ['dataset'], order: 2 },
        ], DSD_TARGET)
        expect(typesOf(fit)).toEqual([['Domain'], ['System'], ['Dataset']])
        expect(howOf(fit)).toEqual(['name', 'name', 'name'])
        expect(fit.matchedLayers).toBe(3)
        expect(fit.unmatchedTypes).toEqual([])
    })

    it("keeps the hints that name the data's types and reports the rest", () => {
        const fit = fitTemplate(LAYERS, ['Dataset', 'System'])
        expect(typesOf(fit)).toEqual([[], ['Dataset'], []])
        expect(fit.typedLayers).toBe(2)
        expect(fit.matchedLayers).toBe(1)
        expect(fit.unmatchedTypes).toEqual(['bounded-context', 'domain', 'table'])
    })
})

describe('fitTemplate — by level', () => {
    it('fills the built-in Analytics Pipeline from a Domain / System / Dataset hierarchy, in order', () => {
        const fit = fitTemplate(ANALYTICS_PIPELINE, DSD_TARGET)
        // Nothing matches by name; the stages take the levels coarsest first,
        // and the one stage past the last level stays — empty, for the person.
        expect(fit.layers.map(l => l.name)).toEqual(['Raw', 'Curated', 'Aggregated', 'Dashboard'])
        expect(typesOf(fit)).toEqual([['Domain'], ['System'], ['Dataset'], []])
        expect(howOf(fit)).toEqual(['level', 'level', 'level', 'none'])
        expect(fit.matchedLayers).toBe(3)
    })

    it('fills only the levels between the layers matched by name around it', () => {
        const fit = fitTemplate([
            { id: 'top', name: 'Top', entityTypes: ['domains'], order: 0 },
            { id: 'mid', name: 'Middle', entityTypes: ['platform'], order: 1 },
            { id: 'leaf', name: 'Leaves', entityTypes: ['dataset'], order: 2 },
            { id: 'after', name: 'After', entityTypes: ['consumer'], order: 3 },
        ], DSD_TARGET)
        expect(typesOf(fit)).toEqual([['Domain'], ['System'], ['Dataset'], []])
        expect(howOf(fit)).toEqual(['name', 'level', 'name', 'none'])
    })

    it('never fills a layer with a type another layer already holds', () => {
        const fit = fitTemplate([
            { id: 'x', name: 'X', entityTypes: ['foo'], order: 0 },
            { id: 'd', name: 'Domains', entityTypes: ['domain'], order: 1 },
        ], DSD_TARGET)
        // Domain is level 0 and already taken; nothing lies above it.
        expect(typesOf(fit)).toEqual([[], ['Domain']])
    })

    it('leaves a layer without hints to be filled by hand', () => {
        const fit = fitTemplate([
            { id: 'a', name: 'Stage', entityTypes: ['stage'], order: 0 },
            { id: 'b', name: 'Watchlist', entityTypes: [], order: 1 },
            { id: 'c', name: 'Stage 2', entityTypes: ['stage2'], order: 2 },
        ], DSD_TARGET)
        expect(typesOf(fit)).toEqual([['Domain'], [], ['System']])
        expect(howOf(fit)).toEqual(['level', 'none', 'level'])
    })

    it('leaves a layer its rules still place alone', () => {
        const fit = fitTemplate([
            { id: 'a', name: 'Tagged', entityTypes: ['stage'], order: 0, rules: [{ id: 'r', tags: ['pii'], priority: 1 }] },
            { id: 'b', name: 'Next', entityTypes: ['stage'], order: 1 },
        ], DSD_TARGET)
        expect(typesOf(fit)).toEqual([[], ['Domain']])
    })

    it('does not fill by level from a flat ontology, which has no order to follow', () => {
        const flat = fitTargetOf({
            entityTypes: DSD.map(t => ({ ...t, hierarchy: { level: 0, canContain: [] } })),
        })
        const fit = fitTemplate(ANALYTICS_PIPELINE, flat)
        expect(typesOf(fit)).toEqual([[], [], [], []])
        expect(howOf(fit)).toEqual(['none', 'none', 'none', 'none'])
    })
})

describe('fitTemplate — when the data has no types to fit to', () => {
    it.each([['not known', null], ['an empty ontology', []], ['no entity types', { types: [] }]] as const)(
        'keeps every hint as written and claims nothing (%s)',
        (_, target) => {
            const fit = fitTemplate(LAYERS, target)
            expect(typesOf(fit)).toEqual([['domain', 'bounded-context'], ['DATASET', 'dataset', 'table'], []])
            expect(howOf(fit)).toEqual(['template', 'template', 'none'])
            expect(fit.layers[1].rules).toEqual(LAYERS[1].rules)
            expect(fit.typedLayers).toBe(0)
            expect(fit.matchedLayers).toBe(0)
            expect(fit.unmatchedTypes).toEqual([])
            expect(fitOutcome(fit, null)).toBeNull()
        },
    )
})

describe('fitTemplate — structure', () => {
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
        expect(Object.keys(fit.fills).sort()).toEqual(fit.layers.map(l => l.id).sort())
    })

    it('remembers the template layer each column came from, for its later versions', () => {
        const fit = fitTemplate(LAYERS, null)
        expect(fit.layers.map(l => l.templateLayerId)).toEqual(LAYERS.map(l => l.id))
    })
})

describe('fitOutcome', () => {
    it("says what the columns will hold, in the data's own words", () => {
        const fit = fitTemplate(ANALYTICS_PIPELINE, DSD_TARGET)
        expect(fitOutcome(fit, DSD_TARGET)).toEqual({ filled: ['Domains', 'Systems', 'Datasets'], byHand: 1 })
    })

    it('counts the layers a person fills when nothing fills them', () => {
        const fit = fitTemplate([{ id: 'a', name: 'Bronze', entityTypes: [], order: 0 }], DSD_TARGET)
        expect(fitOutcome(fit, DSD_TARGET)).toEqual({ filled: [], byHand: 1 })
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
