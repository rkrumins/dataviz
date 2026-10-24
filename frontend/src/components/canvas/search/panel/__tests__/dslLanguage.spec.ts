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

    it('offers edge fields inside .via(', async () => {
        expect(labels(await complete('upstream().via(c|'))).toEqual(['confidence', 'logic'])
    })

    it('offers words, relationships and keys to start a condition with', async () => {
        const r = await complete('up|')
        expect(labels(r)).toEqual(expect.arrayContaining(['type:', 'upstream(…)', '@"…"', 'owner', 'Asset Owner']))
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
