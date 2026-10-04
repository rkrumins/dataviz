/**
 * buildWizardPlacement with `contract` (placementContractEnabled on): the
 * draft layout placed through the One Placement Contract (lib/placement),
 * each entity as a root. The flag-off resolver is pinned by
 * effectivePlacement.test.ts, unedited.
 */
import { describe, it, expect } from 'vitest'
import { buildWizardPlacement } from '../effectivePlacement'
import type { LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'
import type { PlacementFacts } from '@/lib/placement/placement'

const layer = (id: string, order: number, extra: Partial<ViewLayerConfig> = {}): ViewLayerConfig =>
    ({ id, name: id, entityTypes: [], order, sequence: order, ...extra } as ViewLayerConfig)

const entry = (layerId: string): LayerAssignmentEntry => ({ layerId, inheritsChildren: true })

const facts = (urn: string, entityType: string, extra: Partial<PlacementFacts> = {}): PlacementFacts =>
    ({ urn, entityType, tags: [], properties: {}, ...extra })

const contract = (
    layers: ViewLayerConfig[],
    assignments: Record<string, LayerAssignmentEntry> = {},
    scope?: 'all' | 'curated',
) => buildWizardPlacement(layers, assignments, scope, true)

describe('buildWizardPlacement — contract', () => {
    it('resolves a duplicated type to the FIRST layer (the flag-off resolver picks the later one)', () => {
        const layers = [layer('first', 0, { entityTypes: ['Domain'] }), layer('second', 1, { entityTypes: ['Domain'] })]
        expect(contract(layers)({ urn: 'urn:a', type: 'Domain' })).toEqual({ layerId: 'first', source: 'rule', placedBy: 'type' })
        expect(buildWizardPlacement(layers, {})({ urn: 'urn:a', type: 'Domain' }).layerId).toBe('second')
    })

    it('sorts layers by order, not by array position', () => {
        const place = contract([layer('second', 1, { entityTypes: ['Domain'] }), layer('first', 0, { entityTypes: ['Domain'] })])
        expect(place({ urn: 'urn:a', type: 'Domain' }).layerId).toBe('first')
    })

    it('folds the type case', () => {
        const place = contract([layer('domains', 0, { entityTypes: ['Domain'] })])
        expect(place({ urn: 'urn:a', type: 'domain' })).toEqual({ layerId: 'domains', source: 'rule', placedBy: 'type' })
    })

    it('lets an explicit entry beat the rule', () => {
        const place = contract([layer('domains', 0, { entityTypes: ['Domain'] }), layer('special', 1)], { 'urn:a': entry('special') }, 'all')
        expect(place({ urn: 'urn:a', type: 'Domain' })).toEqual({ layerId: 'special', source: 'explicit' })
        expect(place({ urn: 'urn:b', type: 'Domain' })).toEqual({ layerId: 'domains', source: 'rule', placedBy: 'type' })
    })

    it('lets a stale entry fall through to the rule (the flag-off resolver strands it)', () => {
        const layers = [layer('domains', 0, { entityTypes: ['Domain'] })]
        const assignments = { 'urn:a': entry('deleted') }
        expect(contract(layers, assignments, 'all')({ urn: 'urn:a', type: 'Domain' })).toEqual({ layerId: 'domains', source: 'rule', placedBy: 'type' })
        expect(buildWizardPlacement(layers, assignments, 'all')({ urn: 'urn:a', type: 'Domain' })).toEqual({ source: 'none' })
    })

    it('reads tags, properties and the stamp from the facts it is given', () => {
        const place = contract([
            layer('gold', 0, { rules: [{ id: 'tagged', priority: 0, tags: ['gold'] }] }),
            layer('finance', 1, { rules: [{ id: 'owned', priority: 0, propertyMatch: { field: 'owner', operator: 'equals', value: 'Finance' } }] }),
            layer('stamped', 2),
        ])
        expect(place({ urn: 'urn:t', type: 'Table', facts: facts('urn:t', 'Table', { tags: ['gold'] }) }))
            .toEqual({ layerId: 'gold', source: 'rule', placedBy: 'rule' })
        expect(place({ urn: 'urn:p', type: 'Table', facts: facts('urn:p', 'Table', { properties: { owner: 'finance' } }) }))
            .toEqual({ layerId: 'finance', source: 'rule', placedBy: 'rule' })
        expect(place({ urn: 'urn:s', type: 'Table', facts: facts('urn:s', 'Table', { stamp: 'stamped' }) }))
            .toEqual({ layerId: 'stamped', source: 'stamped', placedBy: 'stamp' })
        // Without facts it knows only the URN and type.
        expect(place({ urn: 'urn:t', type: 'Table' })).toEqual({ source: 'none' })
    })

    it('ANDs the criteria of one rule', () => {
        const place = contract([
            layer('gold-tables', 0, { rules: [{ id: 'r', priority: 0, entityTypes: ['Table'], tags: ['gold'] }] }),
        ])
        expect(place({ urn: 'urn:a', type: 'Table', facts: facts('urn:a', 'Table', { tags: ['gold'] }) }).source).toBe('rule')
        expect(place({ urn: 'urn:b', type: 'Table', facts: facts('urn:b', 'Table') }).source).toBe('none')
        expect(place({ urn: 'urn:c', type: 'View', facts: facts('urn:c', 'View', { tags: ['gold'] }) }).source).toBe('none')
    })

    it('calls a rule on entity types alone "type", authored or not, and any other rule "rule"', () => {
        const place = contract([
            layer('tables', 0, { rules: [{ id: 'typed', priority: 0, entityTypes: ['Table'] }] }),
            layer('gold-views', 1, { rules: [{ id: 'mixed', priority: 0, entityTypes: ['View'], tags: ['gold'] }] }),
        ])
        expect(place({ urn: 'urn:a', type: 'Table', facts: facts('urn:a', 'Table') }).placedBy).toBe('type')
        expect(place({ urn: 'urn:b', type: 'View', facts: facts('urn:b', 'View', { tags: ['gold'] }) }).placedBy).toBe('rule')
    })

    it('places nothing by rule or stamp in a curated view, but honours the entry', () => {
        const place = contract([layer('domains', 0, { entityTypes: ['Domain'] })], { 'urn:a': entry('domains') }, 'curated')
        expect(place({ urn: 'urn:a', type: 'Domain' })).toEqual({ layerId: 'domains', source: 'explicit' })
        expect(place({ urn: 'urn:b', type: 'Domain', facts: facts('urn:b', 'Domain', { stamp: 'domains' }) })).toEqual({ source: 'none' })
    })

    it('derives the scope when none is given', () => {
        const layers = [layer('domains', 0, { entityTypes: ['Domain'] })]
        expect(contract(layers)({ urn: 'urn:b', type: 'Domain' }).source).toBe('rule')
        expect(contract(layers, { 'urn:a': entry('domains') })({ urn: 'urn:b', type: 'Domain' }).source).toBe('none')
    })

    it('reports a showUnassigned fallback without a layer — it is display only', () => {
        const place = contract([layer('domains', 0, { entityTypes: ['Domain'] }), layer('rest', 1, { showUnassigned: true })])
        expect(place({ urn: 'urn:a', type: 'Platform' })).toEqual({ source: 'fallback' })
    })

    it('counts a legacy layer.entityAssignments entry as explicit, as the save does', () => {
        const place = contract([
            layer('domains', 0, { entityTypes: ['Domain'] }),
            layer('special', 1, { entityAssignments: [{ entityId: 'urn:a', layerId: 'special', inheritsChildren: true, priority: 0 }] }),
        ], {}, 'all')
        expect(place({ urn: 'urn:a', type: 'Domain' })).toEqual({ layerId: 'special', source: 'explicit' })
    })
})
