/**
 * Round-trip validation for the predicates the W2.3 EdgePredicateEditor
 * emits. The editor itself is a UI; this test treats it as a "factory
 * that produces JSON shapes" and asserts every shape:
 *   * validates against the canonical SearchQuery JSON Schema
 *     when attached to a PathPredicate.edgePredicate slot, and
 *   * round-trips losslessly through the predicateCodec.
 *
 * Catches drift between the editor's typed output and the contract
 * the backend's _visit_edge_property / _visit_edge_has_property /
 * _visit_edge_group compilers consume.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import type { JsonSchemaDocument } from '@/types/jsonSchema'
import type {
    EdgeGroupPredicate,
    EdgeHasPropertyPredicate,
    EdgePropertyPredicate,
    PathPredicate,
    Predicate,
} from '@/types/search'
import {
    decodePredicate,
    encodePredicate,
} from '@/utils/predicateCodec'


let schema: JsonSchemaDocument

beforeAll(() => {
    const path = resolve(
        __dirname,
        '../../../../../../../../backend/common/schema/searchquery.v1.json',
    )
    schema = JSON.parse(readFileSync(path, 'utf-8')) as JsonSchemaDocument
})


function wrap(edge: EdgePropertyPredicate | EdgeHasPropertyPredicate | EdgeGroupPredicate): Predicate {
    const path: PathPredicate = {
        kind: 'path',
        sourceUrns: ['urn:li:dataset:src'],
        targetUrns: ['urn:li:dataset:tgt'],
        edgePredicate: edge,
        maxHops: 4,
        edgeClass: 'lineage',
        direction: 'outgoing',
    }
    return path
}


function assertRoundtrip(predicate: Predicate) {
    const encoded = encodePredicate(predicate)
    const decoded = decodePredicate(encoded, schema)
    expect(decoded).toEqual(predicate)
}


describe('EdgePredicateEditor → JSON Schema (W2.3)', () => {
    it('EdgePropertyPredicate(eq) attaches cleanly to PathPredicate', () => {
        assertRoundtrip(wrap({
            kind: 'edgeProperty',
            key: 'confidence',
            op: 'gte',
            value: 0.8,
        }))
    })

    it('EdgePropertyPredicate(in) with array value', () => {
        assertRoundtrip(wrap({
            kind: 'edgeProperty',
            key: 'discoveredBy',
            op: 'in',
            value: ['manual', 'auto'],
        }))
    })

    it('EdgePropertyPredicate(between) with [lo, hi]', () => {
        assertRoundtrip(wrap({
            kind: 'edgeProperty',
            key: 'confidence',
            op: 'between',
            value: [0.5, 0.95],
        }))
    })

    it('EdgeHasPropertyPredicate', () => {
        assertRoundtrip(wrap({
            kind: 'edgeHasProperty',
            key: 'confidence',
        }))
    })

    it('EdgeGroupPredicate(AND) with two leaves', () => {
        assertRoundtrip(wrap({
            kind: 'edgeGroup',
            op: 'and',
            children: [
                { kind: 'edgeProperty', key: 'confidence', op: 'gte', value: 0.5 },
                { kind: 'edgeHasProperty', key: 'discoveredBy' },
            ],
        }))
    })

    it('EdgeGroupPredicate(NOT) with one child', () => {
        assertRoundtrip(wrap({
            kind: 'edgeGroup',
            op: 'not',
            children: [
                { kind: 'edgeProperty', key: 'discoveredBy', op: 'eq', value: 'auto' },
            ],
        }))
    })

    it('EdgeGroupPredicate(OR) with three branches', () => {
        assertRoundtrip(wrap({
            kind: 'edgeGroup',
            op: 'or',
            children: [
                { kind: 'edgeProperty', key: 'confidence', op: 'gte', value: 0.9 },
                { kind: 'edgeProperty', key: 'priority', op: 'eq', value: 'high' },
                { kind: 'edgeHasProperty', key: 'verified' },
            ],
        }))
    })

    it('Nested EdgeGroupPredicate (group inside group, depth 2)', () => {
        assertRoundtrip(wrap({
            kind: 'edgeGroup',
            op: 'and',
            children: [
                { kind: 'edgeProperty', key: 'confidence', op: 'gte', value: 0.5 },
                {
                    kind: 'edgeGroup',
                    op: 'or',
                    children: [
                        { kind: 'edgeProperty', key: 'discoveredBy', op: 'eq', value: 'manual' },
                        { kind: 'edgeProperty', key: 'discoveredBy', op: 'eq', value: 'auto' },
                    ],
                },
            ],
        }))
    })
})
