/**
 * The four states a feature can be in — and the one that used to have no representation at all.
 *
 * `inert` is the interesting one: a switch that reads ON while a dependency is OFF is doing
 * nothing, and the old page drew it identically to a switch that was working. "Import layers"
 * ships ON and is inert whenever "Edit semantic layers" is off, because importing IS editing —
 * so this is not a theoretical state, it is one click away from the default.
 */
import { describe, expect, it } from 'vitest'
import { blockedBy, dependents, isOn, selectionLabel, stateOf, valueOf } from '../featureState'
import type { FeatureDefinition } from '@/services/featuresService'

function flag(over: Partial<FeatureDefinition> & { key: string }): FeatureDefinition {
    return {
        name: over.key,
        description: '',
        category: 'lineage',
        type: 'boolean',
        default: true,
        ...over,
    } as FeatureDefinition
}

const EDIT = flag({ key: 'semanticLayerEditMode', name: 'Edit semantic layers' })
const IMPORT = flag({
    key: 'semanticLayerImportEnabled',
    name: 'Import layers',
    dependsOn: ['semanticLayerEditMode'],
})
const MODES = flag({
    key: 'allowedViewModes',
    type: 'string[]',
    default: ['graph', 'hierarchy', 'reference', 'layered-lineage'],
    options: [
        { id: 'graph', label: 'Graph' },
        { id: 'hierarchy', label: 'Hierarchy' },
        { id: 'reference', label: 'Context View' },
        { id: 'layered-lineage', label: 'Layered Lineage' },
    ],
})

const ALL = [EDIT, IMPORT, MODES]

describe('valueOf', () => {
    it('falls back to the shipped default when an admin has never saved', () => {
        // A fresh deployment has no stored values at all. Reading `values[key]` alone would report
        // every feature as off and tell the admin their product was dead.
        expect(valueOf(EDIT, {})).toBe(true)
        expect(valueOf(EDIT, { semanticLayerEditMode: false })).toBe(false)
    })
})

describe('stateOf', () => {
    it('on when it is on and nothing blocks it', () => {
        expect(stateOf(EDIT, ALL, { semanticLayerEditMode: true })).toBe('on')
    })

    it('off when the admin turned it off', () => {
        expect(stateOf(EDIT, ALL, { semanticLayerEditMode: false })).toBe('off')
    })

    it('INERT when it is on but a dependency is off — the state the old page could not show', () => {
        const values = { semanticLayerEditMode: false, semanticLayerImportEnabled: true }
        expect(stateOf(IMPORT, ALL, values)).toBe('inert')
        expect(blockedBy(IMPORT, ALL, values).map(f => f.name)).toEqual(['Edit semantic layers'])
    })

    it('off beats inert — a feature the admin turned off is off, whatever its dependencies say', () => {
        const values = { semanticLayerEditMode: false, semanticLayerImportEnabled: false }
        expect(stateOf(IMPORT, ALL, values)).toBe('off')
    })

    it('partial when a list flag has options withdrawn', () => {
        expect(stateOf(MODES, ALL, { allowedViewModes: ['graph', 'hierarchy'] })).toBe('partial')
        expect(stateOf(MODES, ALL, {})).toBe('on') // all four selected
    })

    it('a list flag with nothing selected reads as off', () => {
        expect(isOn(MODES, { allowedViewModes: [] })).toBe(false)
        expect(stateOf(MODES, ALL, { allowedViewModes: [] })).toBe('off')
    })
})

describe('selectionLabel', () => {
    it('counts a list flag against its options, not against itself', () => {
        expect(selectionLabel(MODES, { allowedViewModes: ['graph'] })).toBe('1 of 4')
        expect(selectionLabel(MODES, {})).toBe('4 of 4')
    })

    it('is null for a switch', () => {
        expect(selectionLabel(EDIT, {})).toBeNull()
    })
})

describe('dependents — the cascade nothing on the page used to warn about', () => {
    it('names the features that would be left doing nothing', () => {
        // Turn off "Edit semantic layers" and "Import layers" keeps saying ON while gating nothing:
        // importing IS editing, so the server refuses it either way. The dependency graph was in the
        // registry the whole time; nobody was asked to look at it when it mattered.
        const values = { semanticLayerEditMode: true, semanticLayerImportEnabled: true }
        expect(dependents(EDIT, ALL, values).map(f => f.name)).toEqual(['Import layers'])
    })

    it('ignores a dependent that is already off — it has nothing left to lose', () => {
        const values = { semanticLayerEditMode: true, semanticLayerImportEnabled: false }
        expect(dependents(EDIT, ALL, values)).toEqual([])
    })

    it('is not self-referential, and finds nothing for a feature nobody depends on', () => {
        expect(dependents(IMPORT, ALL, {})).toEqual([])
        expect(dependents(MODES, ALL, {})).toEqual([])
    })
})
