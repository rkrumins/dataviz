/**
 * Round-trip property + unit tests for predicateCodec.
 *
 * The contract under test: encode then decode (decode then encode)
 * preserves a Predicate exactly. Anything that breaks this invariant
 * also breaks the builder ↔ JSON peer-view promise, so the property
 * test is the foundation of W0.
 */
import * as fc from 'fast-check'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, beforeAll } from 'vitest'

import type { Predicate } from '@/types/search'
import type { JsonSchemaDocument } from '@/types/jsonSchema'
import {
    PredicateValidationError,
    decodePredicate,
    decodeSearchQuery,
    encodePredicate,
    encodeSearchQuery,
} from '@/utils/predicateCodec'


// Load the canonical schema once. We load directly from the committed
// artifact so the test does not depend on a running backend; this is
// the same schema the FE codegen step consumes.
let schema: JsonSchemaDocument

beforeAll(() => {
    const path = resolve(
        __dirname,
        '../../../../backend/common/schema/searchquery.v1.json',
    )
    schema = JSON.parse(readFileSync(path, 'utf-8')) as JsonSchemaDocument
})


// ---------------------------------------------------------------------------
// Generators — one per predicate kind. Each generator emits a SHAPE the
// JSON Schema will accept, so the codec can validate the round trip.
// ---------------------------------------------------------------------------

const arbSafeString = fc.string({ minLength: 1, maxLength: 32 }).filter((s) => s.trim().length > 0)
const arbPropertyKey = fc
    .stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,20}$/)
    .filter((s) => s.length > 0)
const arbUrn = fc
    .tuple(arbSafeString, arbSafeString)
    .map(([a, b]) => `urn:nexus:${a}:${b}`)

const arbTextPredicate = fc.record({
    kind: fc.constant('text' as const),
    value: arbSafeString,
    target: fc.constantFrom('name', 'qualifiedName', 'description'),
    match: fc.constantFrom('exact', 'prefix', 'substring'),
})

const arbPropertyPredicate = fc.record({
    kind: fc.constant('property' as const),
    key: arbPropertyKey,
    op: fc.constantFrom('eq', 'neq', 'gt', 'gte', 'lt', 'lte'),
    value: fc.oneof(fc.integer(), fc.string({ minLength: 0, maxLength: 16 })),
})

const arbTagPredicate = fc.record({
    kind: fc.constant('tag' as const),
    op: fc.constantFrom('has', 'hasAny', 'hasAll', 'notHas'),
    values: fc.array(arbSafeString, { minLength: 1, maxLength: 4 }),
})

const arbHasPropertyPredicate = fc.record({
    kind: fc.constant('hasProperty' as const),
    key: arbPropertyKey,
    negate: fc.boolean(),
})

const arbEntityTypePredicate = fc.record({
    kind: fc.constant('entityType' as const),
    op: fc.constantFrom('in', 'notIn'),
    values: fc.array(arbPropertyKey, { minLength: 1, maxLength: 4 }),
})

const arbLayerPredicate = fc.record({
    kind: fc.constant('layer' as const),
    layerAssignment: arbSafeString,
})

const arbIsOrphanPredicate = fc.record({
    kind: fc.constant('isOrphan' as const),
    edgeClass: fc.constantFrom('lineage', 'containment', 'any'),
})

const arbIsLeafPredicate = fc.record({
    kind: fc.constant('isLeaf' as const),
    edgeClass: fc.constantFrom('lineage', 'containment', 'any'),
})

const arbDegreePredicate = fc.record({
    kind: fc.constant('degree' as const),
    direction: fc.constantFrom('in', 'out', 'both'),
    op: fc.constantFrom('eq', 'gt', 'gte', 'lt', 'lte'),
    value: fc.integer({ min: 0, max: 100 }),
    edgeClass: fc.constantFrom('lineage', 'containment', 'any'),
})

const arbLeafPredicate = fc.oneof(
    arbTextPredicate,
    arbPropertyPredicate,
    arbTagPredicate,
    arbHasPropertyPredicate,
    arbEntityTypePredicate,
    arbLayerPredicate,
    arbIsOrphanPredicate,
    arbIsLeafPredicate,
    arbDegreePredicate,
)

// Bounded recursive predicate — fast-check's `letrec` keeps depth small
// (default `maxDepth: 2`) which mirrors what users actually compose in
// the visual builder.
const { predicate: arbPredicate } = fc.letrec((tie) => ({
    predicate: fc.oneof(
        { maxDepth: 3 },
        arbLeafPredicate,
        fc.record({
            kind: fc.constant('group' as const),
            op: fc.constantFrom('and', 'or'),
            children: fc.array(tie('predicate'), { minLength: 1, maxLength: 4 }),
        }),
    ),
})) as { predicate: fc.Arbitrary<Predicate> }


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('predicateCodec — round-trip', () => {
    it('decode(encode(p)) preserves every leaf shape', () => {
        fc.assert(
            fc.property(arbLeafPredicate, (p) => {
                const json = encodePredicate(p as Predicate)
                const reparsed = decodePredicate(json, schema)
                // Re-encode and compare strings: this catches any silent
                // shape mutation (extra keys, dropped fields) that a
                // deep-equal might paper over.
                expect(encodePredicate(reparsed)).toBe(json)
            }),
            { numRuns: 200 },
        )
    })

    it('decode(encode(p)) preserves nested group trees', () => {
        fc.assert(
            fc.property(arbPredicate, (p) => {
                const json = encodePredicate(p)
                const reparsed = decodePredicate(json, schema)
                expect(encodePredicate(reparsed)).toBe(json)
            }),
            { numRuns: 100 },
        )
    })

    it('canonical encoding puts `kind` first', () => {
        const p: Predicate = {
            // intentionally place ``kind`` last; encode must reorder
            value: 'test',
            target: 'name',
            kind: 'text',
        } as unknown as Predicate
        const json = encodePredicate(p)
        // ``kind`` appears as the first property in the JSON output
        expect(json.indexOf('"kind"')).toBeGreaterThan(-1)
        expect(json.indexOf('"kind"')).toBeLessThan(json.indexOf('"value"'))
    })

    it('encode is stable across re-encoding', () => {
        const p: Predicate = {
            kind: 'group',
            op: 'or',
            children: [
                { kind: 'tag', op: 'hasAny', values: ['PII', 'GDPR'] },
                { kind: 'property', key: 'rowCount', op: 'gt', value: 1000 },
            ],
        }
        const a = encodePredicate(p)
        const b = encodePredicate(decodePredicate(a, schema))
        const c = encodePredicate(decodePredicate(b, schema))
        expect(a).toBe(b)
        expect(b).toBe(c)
    })
})


describe('predicateCodec — validation errors', () => {
    it('rejects unknown discriminator with a structured issue list', () => {
        expect(() =>
            decodePredicate('{"kind": "doesNotExist"}', schema),
        ).toThrow(PredicateValidationError)
    })

    it('rejects invalid JSON with an error pointing at the parse failure', () => {
        try {
            decodePredicate('{ not json }', schema)
            throw new Error('should have thrown')
        } catch (err) {
            expect(err).toBeInstanceOf(PredicateValidationError)
            expect((err as PredicateValidationError).issues.length).toBeGreaterThan(0)
        }
    })

    it('accepts a full SearchQuery and rejects one missing required scope', () => {
        const validQuery = {
            $schemaVersion: '1',
            predicate: { kind: 'isOrphan', edgeClass: 'lineage' },
            scope: { viewId: 'view:test' },
        }
        const encoded = encodeSearchQuery(validQuery as never)
        expect(() => decodeSearchQuery(encoded, schema)).not.toThrow()

        const invalidQuery = {
            $schemaVersion: '1',
            predicate: { kind: 'isOrphan', edgeClass: 'lineage' },
            // scope omitted — required
        }
        expect(() =>
            decodeSearchQuery(JSON.stringify(invalidQuery), schema),
        ).toThrow(PredicateValidationError)
    })
})
