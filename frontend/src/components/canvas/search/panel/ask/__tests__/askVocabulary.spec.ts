/**
 * The view's words as a question finds them: lowercase, one or several,
 * an identifier's words apart, a key without the suffix people leave off.
 */
import { describe, expect, it } from 'vitest'

import { buildAskVocabulary, identifierWords, normalWord } from '../askVocabulary'


describe('askVocabulary', () => {
    it.each([
        ['Datasets', 'dataset'], ['entries', 'entry'], ['classes', 'class'], ['boxes', 'box'],
        ['status', 'status'], ['analysis', 'analysis'], ['PII', 'pii'], ['owner\'s', 'owner'], ['ops', 'ops'],
    ])('files %s under %s', (word, normal) => expect(normalWord(word)).toBe(normal))

    it('splits an identifier into its words', () => {
        expect(identifierWords('rowCount')).toEqual(['row', 'Count'])
        expect(identifierWords('updated_at')).toEqual(['updated', 'at'])
        expect(identifierWords('HTTPServer')).toEqual(['HTTP', 'Server'])
    })

    it('finds each word of the view under every way it is typed', () => {
        const { phrases, longest } = buildAskVocabulary({
            entityTypes: [{ id: 'dataPlatform', name: 'Data Platform', pluralName: 'Data Platforms' }],
            tagValues: ['PII'], propertyKeys: ['rowCount', 'updatedAt'],
            valueSamples: [{ key: 'owner', value: 'sales-ops@corp' }],
            layers: [{ value: 'gold', label: 'Gold' }],
        })
        expect(phrases.get('data platform')).toEqual([{ kind: 'type', type: 'dataPlatform' }])
        expect(phrases.get('dataplatform')).toEqual([{ kind: 'type', type: 'dataPlatform' }])
        expect(phrases.get('row count')).toEqual([{ kind: 'key', key: 'rowCount' }])
        expect(phrases.get('row')).toEqual([{ kind: 'key', key: 'rowCount' }])
        expect(phrases.get('updated')).toEqual([{ kind: 'key', key: 'updatedAt' }])
        expect(phrases.get('sales-ops@corp')).toEqual([{ kind: 'value', key: 'owner', value: 'sales-ops@corp' }])
        expect(phrases.get('gold layer')).toEqual([{ kind: 'layer', value: 'gold', label: 'Gold' }])
        expect(phrases.get('pii')).toEqual([{ kind: 'tag', tag: 'PII' }])
        expect(longest).toBe(2)
    })
})
