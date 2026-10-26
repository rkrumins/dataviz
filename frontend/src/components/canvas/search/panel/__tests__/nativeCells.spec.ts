/**
 * nativeCells — what Highlight on canvas lights up from a native query's
 * answer: every node's urn (in paths, lists and maps too) and every value
 * of a column named for urns, once each, in order.
 */
import { describe, expect, it } from 'vitest'

import { cellText, isNativeResult, NATIVE_RESULT_PREFIX, urnsOf } from '../native/nativeCells'

const node = (urn: string | null, id = urn ?? 'x') => ({
    kind: 'node', id, labels: ['Dataset'], urn, displayName: urn, properties: {},
})


describe('urnsOf', () => {
    it('finds nodes wherever they sit in a row', () => {
        const path = { kind: 'path', nodes: [node('urn:a'), node('urn:b')], edges: [] }
        const list = { kind: 'list', items: [node('urn:c'), 1, null] }
        const map = { kind: 'map', entries: { first: node('urn:d'), n: 2 } }
        expect(urnsOf(['p', 'l', 'm', 'n'], [[path, list, map, node('urn:a')]]))
            .toEqual(['urn:a', 'urn:b', 'urn:c', 'urn:d'])
    })

    it('reads a column named for urns, and no other strings', () => {
        expect(urnsOf(['n.urn', 'n.displayName', 'urn', '`m`.`urn`'], [
            ['urn:x', 'urn:not-this', 'urn:y', 'urn:z'],
        ])).toEqual(['urn:x', 'urn:y', 'urn:z'])
    })

    it('skips nodes without a urn, and empty answers', () => {
        expect(urnsOf(['n'], [[node(null, '7')]])).toEqual([])
        expect(urnsOf([], [])).toEqual([])
    })
})


describe('cellText', () => {
    it('says each kind in a line', () => {
        expect(cellText(null)).toBe('null')
        expect(cellText(3)).toBe('3')
        expect(cellText({ kind: 'edge', id: '1', type: 'FEEDS', start: '1', end: '2', properties: {} }))
            .toBe('-[FEEDS]->')
        expect(cellText({ kind: 'path', nodes: [], edges: [], size: 1 })).toBe('path of 1 step')
        expect(cellText({ kind: 'point', srid: 7203, coordinates: [1, 2] })).toBe('point(1, 2)')
        expect(cellText({ kind: 'list', items: [1, 'a'] })).toBe('[1, a]')
    })
})


describe('native results in the search store', () => {
    it('are marked by their query hash', () => {
        expect(isNativeResult(`${NATIVE_RESULT_PREFIX}abc`)).toBe(true)
        expect(isNativeResult('{"kind":"text"}')).toBe(false)
        expect(isNativeResult(null)).toBe(false)
    })
})
