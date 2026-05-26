/**
 * Per-template validation tests.
 *
 * Every template's ``build(defaultInputs)`` must produce a predicate
 * that:
 *   * validates against the canonical SearchQuery JSON Schema, and
 *   * round-trips through the predicate codec losslessly.
 *
 * Catches drift between the JSON DSL contract and the templates that
 * produce queries — a malformed default template would silently
 * 400 every time the user clicked the chip.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import {
    TEMPLATES,
    defaultInputs,
    type SearchTemplate,
} from '@/components/canvas/search/searchTemplates'
import type { JsonSchemaDocument } from '@/types/jsonSchema'
import {
    decodePredicate,
    encodePredicate,
} from '@/utils/predicateCodec'


let schema: JsonSchemaDocument

beforeAll(() => {
    const path = resolve(
        __dirname,
        '../../../../../../backend/common/schema/searchquery.v1.json',
    )
    schema = JSON.parse(readFileSync(path, 'utf-8')) as JsonSchemaDocument
})


/** Templates that require user input to produce a valid predicate
 * (their defaults are empty strings the user must fill in). For
 * schema-validation testing we substitute a sensible non-empty value
 * so we can still verify the build() SHAPE is well-formed.
 *
 * The keys here match the ``name`` field of the template's input
 * objects, mapped to a value that satisfies the predicate the
 * template builds (e.g. a property key needs at least 1 char). */
const REQUIRED_INPUT_FILLERS: Record<string, string | number> = {
    text: 'orders',
    value: 'STRING',
    key: 'owner',
    anchorUrn: 'urn:li:dataset:example',
    sourceUrn: 'urn:li:dataset:source',
    targetUrn: 'urn:li:dataset:target',
    propertyKey: 'layerAssignment',
}


function filledInputs(template: SearchTemplate): Record<string, string | number> {
    const out = defaultInputs(template)
    for (const input of template.inputs) {
        const current = out[input.name]
        const looksEmpty = current === '' || current === 0
        if (looksEmpty && REQUIRED_INPUT_FILLERS[input.name] !== undefined) {
            out[input.name] = REQUIRED_INPUT_FILLERS[input.name]
        }
    }
    return out
}


describe('TEMPLATES — every entry produces a valid SearchQuery', () => {
    it.each(TEMPLATES.map((t) => [t.id, t] as const))(
        '%s validates against the schema',
        (_id: string, template: SearchTemplate) => {
            const query = template.build(filledInputs(template))
            expect(query.predicate).toBeDefined()
            // ``decodePredicate`` runs the Ajv validator bound to the
            // SearchQuery ``$defs/Predicate`` ref — it throws on schema
            // violations. Round-trip via encode/decode catches any
            // canonicalisation drift.
            const encoded = encodePredicate(query.predicate)
            const decoded = decodePredicate(encoded, schema)
            expect(decoded).toEqual(query.predicate)
        },
    )

    it('every template carries a section', () => {
        for (const t of TEMPLATES) {
            expect(t.section).toMatch(
                /^(overview|find|governance|lineage|discovery)$/,
            )
        }
    })

    it('all nine W2.5 named templates are present', () => {
        const required = [
            'pii-spread', 'untagged-datasets', 'property-coverage-owner',
            'lineage-gaps', 'stale-lineage', 'cross-layer-paths',
            'most-referenced-datasets', 'orphan-datasets-by-layer',
            'schema-fields-by-logical-type',
        ]
        const ids = new Set(TEMPLATES.map((t) => t.id))
        for (const id of required) {
            expect(ids.has(id)).toBe(true)
        }
    })
})
