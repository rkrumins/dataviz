import { describe, it, expect } from 'vitest'
import { buildWizardPlacement, resolveWizardEntityScope } from '../effectivePlacement'
import type { LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'

const layer = (id: string, order: number, entityTypes: string[] = []): ViewLayerConfig =>
    ({ id, name: id, entityTypes, order, sequence: order } as ViewLayerConfig)

const entry = (layerId: string): LayerAssignmentEntry =>
    ({ layerId, inheritsChildren: true })

describe('buildWizardPlacement', () => {
    it('places a root by its layer type rule', () => {
        const place = buildWizardPlacement([layer('domains', 0, ['Domain'])], {})
        expect(place({ urn: 'urn:a', type: 'Domain' })).toEqual({ layerId: 'domains', source: 'rule' })
    })

    it('reports nowhere for a type no layer declares', () => {
        const place = buildWizardPlacement([layer('domains', 0, ['Domain'])], {})
        expect(place({ urn: 'urn:a', type: 'Platform' })).toEqual({ source: 'none' })
    })

    it('reports nowhere when no layer declares any type', () => {
        const place = buildWizardPlacement([layer('empty', 0)], {})
        expect(place({ urn: 'urn:a', type: 'Domain' })).toEqual({ source: 'none' })
    })

    it('lets an explicit assignment override the type rule', () => {
        const place = buildWizardPlacement(
            [layer('domains', 0, ['Domain']), layer('special', 1)],
            { 'urn:a': entry('special') },
            'all',
        )
        expect(place({ urn: 'urn:a', type: 'Domain' })).toEqual({ layerId: 'special', source: 'explicit' })
        // Its siblings still follow the rule.
        expect(place({ urn: 'urn:b', type: 'Domain' })).toEqual({ layerId: 'domains', source: 'rule' })
    })

    it('reports NO rule placement in a curated view — the canvas makes none', () => {
        // resolveRootLayer reaches `ruleAssignment` only down the open branch, so
        // badging a root "by type" here would promise a placement the canvas
        // drops and curated hydration never even fetches.
        const place = buildWizardPlacement([layer('domains', 0, ['Domain'])], {}, 'curated')
        expect(place({ urn: 'urn:b', type: 'Domain' })).toEqual({ source: 'none' })
    })

    it('still honours an explicit assignment under curated scope', () => {
        const place = buildWizardPlacement(
            [layer('domains', 0, ['Domain'])], { 'urn:a': entry('domains') }, 'curated',
        )
        expect(place({ urn: 'urn:a', type: 'Domain' })).toEqual({ layerId: 'domains', source: 'explicit' })
    })

    it('derives the scope when none is given, as deriveEntityScope does', () => {
        const layers = [layer('domains', 0, ['Domain'])]
        // No assignments -> open -> rules apply.
        expect(buildWizardPlacement(layers, {})({ urn: 'urn:b', type: 'Domain' }).source).toBe('rule')
        // Any assignment -> curated -> they do not.
        expect(buildWizardPlacement(layers, { 'urn:a': entry('domains') })(
            { urn: 'urn:b', type: 'Domain' }).source).toBe('none')
    })

    it('resolves a duplicated type to the LATER layer, matching the canvas', () => {
        // Generated rules are priced layer.order * 10 + idx and the resolver
        // sorts highest-first, so the later column wins. Build Mode's
        // buildTypeLayerMap is first-wins — the wizard must not use it.
        const place = buildWizardPlacement(
            [layer('first', 0, ['Domain']), layer('second', 1, ['Domain'])],
            {},
        )
        expect(place({ urn: 'urn:a', type: 'Domain' }).layerId).toBe('second')
    })

    it('sorts layers by order, not by array position', () => {
        const place = buildWizardPlacement(
            [layer('second', 1, ['Domain']), layer('first', 0, ['Domain'])],
            {},
        )
        expect(place({ urn: 'urn:a', type: 'Domain' }).layerId).toBe('second')
    })

    it('does NOT fold case — a casing mismatch really does render nowhere', () => {
        const place = buildWizardPlacement([layer('domains', 0, ['Domain'])], {})
        expect(place({ urn: 'urn:a', type: 'domain' })).toEqual({ source: 'none' })
    })

    it('refuses an explicit assignment naming a layer that no longer exists', () => {
        const place = buildWizardPlacement([layer('domains', 0, ['Domain'])], { 'urn:a': entry('deleted') })
        expect(place({ urn: 'urn:a', type: 'Domain' })).toEqual({ source: 'none' })
    })
})

describe('resolveWizardEntityScope', () => {
    const ruleDriven = { layers: [layer('domains', 0, ['Domain'])], assignments: {} }
    const handPlaced = { layers: [layer('plain', 0)], assignments: { 'urn:a': entry('plain') } }

    it('honours a pin while some layer still carries a type rule', () => {
        expect(resolveWizardEntityScope('all', ruleDriven, undefined)).toBe('all')
    })

    it('keeps honouring the pin once the user has also dragged one entity', () => {
        // The whole point: deriveEntityScope alone would answer 'curated' here
        // and every rule-placed root would vanish from the canvas.
        const mixed = { layers: [layer('domains', 0, ['Domain'])], assignments: { 'urn:a': entry('domains') } }
        expect(resolveWizardEntityScope('all', mixed, undefined)).toBe('all')
        expect(resolveWizardEntityScope(undefined, mixed, undefined)).toBe('curated')
    })

    it('drops a stale pin once no layer carries a rule (undo, or layer deleted)', () => {
        expect(resolveWizardEntityScope('all', handPlaced, undefined)).toBe('curated')
    })

    it('derives exactly as before when nothing is pinned', () => {
        expect(resolveWizardEntityScope(undefined, ruleDriven, undefined)).toBe('all')
        expect(resolveWizardEntityScope(undefined, handPlaced, undefined)).toBe('curated')
    })

    it("lets a pin outrank the edited view's stored scope", () => {
        const content = { entityScope: 'curated' } as never
        expect(resolveWizardEntityScope('all', ruleDriven, content)).toBe('all')
        expect(resolveWizardEntityScope(undefined, ruleDriven, content)).toBe('curated')
    })
})
