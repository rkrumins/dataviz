import { describe, it, expect } from 'vitest'
import {
    buildNameSuggestions,
    isHumanLabel,
    CURATED_SUGGESTIONS,
} from '../nameSuggestions'

describe('isHumanLabel', () => {
    it('accepts labels a person would recognise', () => {
        expect(isHumanLabel('Finance')).toBe(true)
        expect(isHumanLabel('Core DWH')).toBe(true)
        expect(isHumanLabel('Customer 360')).toBe(true)
        expect(isHumanLabel('Sales & Ops')).toBe(true)
    })

    it('rejects machine-minted identifiers', () => {
        expect(isHumanLabel('ds_930583737602')).toBe(false)   // snake_case + digit blob
        expect(isHumanLabel('roots-node')).toBe(false)        // lowercase slug
        expect(isHumanLabel('urn:synodic:solidatus')).toBe(false)
        expect(isHumanLabel('3e105c56b3b4')).toBe(false)      // doesn't start with a letter
        expect(isHumanLabel('warehouse/prod')).toBe(false)
    })

    it('rejects placeholders and empties', () => {
        expect(isHumanLabel('Unknown')).toBe(false)
        expect(isHumanLabel('Data Source')).toBe(false)
        expect(isHumanLabel('Blank model')).toBe(false)
        expect(isHumanLabel('')).toBe(false)
        expect(isHumanLabel(undefined)).toBe(false)
        expect(isHumanLabel('A very long data source label indeed')).toBe(false)
    })
})

describe('buildNameSuggestions', () => {
    it('offers the curated list when there is no scope at all', () => {
        expect(buildNameSuggestions(undefined, [])).toEqual([...CURATED_SUGGESTIONS])
    })

    it('leads with the data source when its label is a real name', () => {
        const out = buildNameSuggestions({ dataSourceLabel: 'Finance' }, [])

        expect(out[0]).toBe('Finance Lineage')
        // The curated list still follows, capped at 6 overall.
        expect(out.slice(1)).toEqual(CURATED_SUGGESTIONS.slice(0, 5))
        expect(out).toHaveLength(6)
    })

    it('never templates an identifier-shaped label into a name', () => {
        const out = buildNameSuggestions({ dataSourceLabel: 'ds_930583737602' }, [])

        expect(out).toEqual([...CURATED_SUGGESTIONS])
        expect(out.some(s => s.includes('ds_'))).toBe(false)
    })

    it('ignores workspace, ontology and entity types entirely (they read badly)', () => {
        const out = buildNameSuggestions(
            { workspaceName: 'Overlay WS', ontologyName: 'Solidatus multi-containment' },
            [{ id: 'zone', name: 'Zone', pluralName: 'Zones', hierarchy: { level: 0, canContain: ['asset'] } }],
        )

        expect(out).toEqual([...CURATED_SUGGESTIONS])
        expect(out).not.toContain('Overlay WS Overview')
        expect(out).not.toContain('Solidatus multi-containment Model')
        expect(out).not.toContain('Zones Landscape')
    })

    it('gives blank models the curated list only (their label is the ontology name)', () => {
        const out = buildNameSuggestions(
            { dataSourceLabel: 'Banking Model', ontologyName: 'Banking Model', isBlank: true },
            [],
        )

        expect(out).toEqual([...CURATED_SUGGESTIONS])
        expect(out).not.toContain('Banking Model Lineage')
    })

    it('dedupes case-insensitively', () => {
        const out = buildNameSuggestions({ dataSourceLabel: 'Data' }, [])

        // "Data Lineage" from the label collides with the curated entry.
        expect(out.filter(s => s.toLowerCase() === 'data lineage')).toHaveLength(1)
    })
})
