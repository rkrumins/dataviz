import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it, vi } from 'vitest'

import {
    completionContextAt,
    type DslVocabulary,
    dslCompletionSource,
    dslDiagnostics,
    dslRanges,
} from '../dsl/dslLanguage'


const VOCAB: DslVocabulary = {
    entityTypes: ['dataset', 'dashboard', 'data product'],
    tags: ['PII', 'GDPR'],
    layers: ['Source'],
    propertyKeys: ['owner', 'Asset Owner'],
    edgeKeys: ['confidence', 'logic'],
    edgeTypes: [
        { id: 'PRODUCES', detail: 'Produces · Data job → Dataset' },
        { id: 'DEFINED_BY', detail: 'Defined by' },
        { id: 'CONTAINS', detail: 'Contains', containment: true },
    ],
}

/** Where ``|`` stands in ``doc``, and ``doc`` without it. */
function cursor(doc: string): [string, number] {
    return [doc.replace('|', ''), doc.indexOf('|')]
}

async function complete(doc: string, vocab: DslVocabulary = VOCAB, explicit = false) {
    const [text, pos] = cursor(doc)
    const ctx = new CompletionContext(EditorState.create({ doc: text }), pos, explicit)
    return (await dslCompletionSource(() => vocab)(ctx)) as CompletionResult | null
}

const labels = (r: CompletionResult | null) => (r?.options ?? []).map((o) => o.label)


describe('dslLanguage — highlighting and the underline', () => {
    it('colours each token for what the parser read, key:value in two parts', () => {
        const text = 'type:dataset owner = x'
        expect(dslRanges(text).map((r) => [text.slice(r.from, r.to), r.role])).toEqual([
            ['type:', 'prefix'], ['dataset', 'value'], ['owner', 'field'], ['=', 'operator'], ['x', 'value'],
        ])
    })

    it('underlines the error where it points — the last character when past the end', () => {
        const at = (text: string) => dslDiagnostics(text).map((d) => [text.slice(d.from, d.to), d.message])
        expect(at('a )')).toEqual([[')', 'Unexpected )']])
        expect(at('parent(type:x')).toEqual([['x', 'Missing ")" after parent(…']])
        expect(at('type:dataset')).toEqual([])
    })

    it('warns about each edge type this data source lacks, once its edge types are known', () => {
        const at = (text: string, edgeTypes = VOCAB.edgeTypes) => dslDiagnostics(text, edgeTypes)
            .map((d) => [text.slice(d.from, d.to), d.severity, d.message])
        expect(at('outgoing[PRODUCES, PRODUCE ](x) noEdges[any] noIncoming[defined_by]')).toEqual([
            ['PRODUCE', 'warning', "Edge type PRODUCE isn't in this data source"]])
        expect(at('edges[TAGS](in) > 1')).toEqual([['TAGS', 'warning', "Edge type TAGS isn't in this data source"]])
        // Not before they are known, and a query that doesn't read gets its error alone.
        expect(at('outgoing[PRODUCE](x)', [])).toEqual([])
        expect(at('outgoing[PRODUCE](x')).toEqual([['x', 'error', 'Missing ")" after outgoing[PRODUCE](…']])
    })
})


describe('dslLanguage — what the cursor is in the middle of', () => {
    it.each<[string, ReturnType<typeof completionContextAt>]>([
        ['upstream(@"Sal|', { kind: 'name', from: 11, text: 'Sal' }],
        ['type:dataset,da|', { kind: 'prefixValue', prefix: 'type', from: 13, text: 'da', taken: ['dataset'] }],
        ['tag:|', { kind: 'prefixValue', prefix: 'tag', from: 4, text: '', taken: [] }],
        ['owner = al|', { kind: 'value', key: 'owner', from: 8, text: 'al', quoted: false }],
        ['"Asset Owner" != "B|', { kind: 'value', key: 'Asset Owner', from: 18, text: 'B', quoted: true }],
        ['description CONTAINS cu|', { kind: 'value', key: 'description', from: 21, text: 'cu', quoted: false }],
        ['upstream().via(con|', { kind: 'edgeKey', from: 15, text: 'con' }],
        ['upstream().via(x = 1) ty|', { kind: 'term', from: 22, text: 'ty' }],
        ['type:dataset AND up|', { kind: 'term', from: 17, text: 'up' }],
        ['outgoing[PR|', { kind: 'edgeType', from: 9, text: 'PR', taken: [], connection: true }],
        ['count(feeds*..3[PRODUCES, D|', { kind: 'edgeType', from: 26, text: 'D', taken: ['PRODUCES'],
            connection: true }],
        ['noIncoming[|', { kind: 'edgeType', from: 11, text: '', taken: [], connection: false }],
        ['edges[|', { kind: 'edgeType', from: 6, text: '', taken: [], connection: false }],
        ['foo[ba|', { kind: 'term', from: 0, text: 'foo[ba' }],
        ['freshness > {sl|', { kind: 'keyRef', from: 13, text: 'sl' }],
    ])('reads %s', (doc, expected) => {
        const [text, pos] = cursor(doc)
        expect(completionContextAt(text, pos)).toEqual(expected)
    })
})


describe('dslLanguage — completion', () => {
    it('offers the values a prefix takes, leaving out those written and those that need quotes', async () => {
        expect(labels(await complete('type:dataset,|'))).toEqual(['dashboard'])
        expect(labels(await complete('tag:|'))).toEqual(['PII', 'GDPR'])
    })

    it("offers a property's values from the server, quoted when they must be", async () => {
        const suggestValues = vi.fn(async () => ({ values: [{ value: 'alice' }, { value: 'Ops team' }] }))
        const r = await complete('owner = |', { ...VOCAB, suggestValues })
        expect(suggestValues).toHaveBeenCalledWith('owner', '')
        expect(r?.options.map((o) => [o.label, o.apply])).toEqual([['alice', 'alice'], ['Ops team', '"Ops team"']])
    })

    it('offers edge types in brackets — a class first, never the hierarchy’s on a connection', async () => {
        const r = await complete('outgoing[|')
        expect(labels(r)).toEqual(['lineage', 'links', 'PRODUCES', 'DEFINED_BY'])
        expect(r?.options.find((o) => o.label === 'PRODUCES')?.detail).toBe('Produces · Data job → Dataset')
        // A shape or a count takes every class and the hierarchy's types too.
        expect(labels(await complete('noEdges[|'))).toEqual(['lineage', 'links', 'any', 'containment',
            'PRODUCES', 'DEFINED_BY', 'CONTAINS'])
        // After a name: other names only.
        expect(labels(await complete('incoming[PRODUCES, |'))).toEqual(['DEFINED_BY'])
    })

    it('offers another property inside the braces after a comparison', async () => {
        const r = await complete('freshness > {|')
        expect(labels(r)).toEqual(['owner', 'Asset Owner'])
        expect(r?.options[0].detail).toBe('another property')
    })

    it('offers edge fields inside .via(', async () => {
        expect(labels(await complete('upstream().via(c|'))).toEqual(['confidence', 'logic'])
    })

    it('offers words, relationships and keys to start a condition with', async () => {
        const r = await complete('fe|')
        expect(labels(r)).toEqual(expect.arrayContaining(['type:', 'feeds(…)', 'fedBy(…)', 'linkedTo(…)',
            'outgoing[…](…)', 'noLinks', 'edges(…) >', '@"…"', 'owner', 'Asset Owner']))
        // The older spellings still complete, said to be older.
        expect(r?.options.find((o) => o.label === 'upstream(…)')?.detail).toBe('older spelling of fedBy(…)')
        expect(r?.options.find((o) => o.label === 'Asset Owner')?.apply).toBe('"Asset Owner"')
        // Nothing unasked at a blank spot; Ctrl-Space asks.
        expect(await complete('a |')).toBeNull()
        expect(await complete('a |', VOCAB, true)).not.toBeNull()
    })

    it('finds entities by name from the server, after a pause', async () => {
        const search = vi.fn(async () => [
            { urn: 'urn:1', name: 'Sales', type: 'domain', ancestors: [] },
            { urn: 'urn:2', name: 'Sales', type: 'dataset', ancestors: ['Finance'] },
        ])
        const r = await complete('@"Sal|', { ...VOCAB, names: { search, pathFor: vi.fn() } })
        expect(search).toHaveBeenCalledWith('Sal', expect.any(AbortSignal))
        expect(r?.options.map((o) => [o.label, o.detail])).toEqual([
            ['Sales', 'domain'], ['Sales', 'dataset · Finance']])
        expect(await complete('@"|', { ...VOCAB, names: { search, pathFor: vi.fn() } })).toBeNull()
    })
})
