import { type Completion, CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'

import { OPERATOR_TABLE, type PropertyOperator } from '@/types/generated/searchOperators'

import {
    comparedField,
    completionContextAt,
    conditionAtHead,
    type DslVocabulary,
    dslCompletionSource,
    dslDiagnostics,
    dslRanges,
    fieldOperators,
    operatorSnippet,
    suffixOptions,
    widerCondition,
} from '../dsl/dslLanguage'
import { parsePredicate, PROP_OP_STR, RELATION_WORDS, SHAPE_WORDS } from '../predicateDsl'


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
    it('offers the values a prefix takes, leaving out those written', async () => {
        expect(labels(await complete('tag:|'))).toEqual(['PII', 'GDPR'])
        // One that needs quotes is written in them — as the first value: a
        // list after a comma takes none, so there it is left out.
        expect((await complete('type:|'))?.options.map((o) => [o.label, o.apply])).toEqual([
            ['dataset', undefined], ['dashboard', undefined], ['data product', '"data product"']])
        expect(labels(await complete('type:dataset,|'))).toEqual(['dashboard'])
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


describe('dslLanguage — a layer name of several words', () => {
    const LAYERS: DslVocabulary = { ...VOCAB, layers: ['Source', 'My Cool Layer', "Bob's layer", 'The "best" layer'] }

    it.each<[string, ReturnType<typeof completionContextAt>]>([
        ['layer:"My C|', { kind: 'layerName', from: 7, text: 'My C', quote: '"' }],
        ["layer = 'My|", { kind: 'layerName', from: 9, text: 'My', quote: "'" }],
        ['feeds(layer:My Co|', { kind: 'layerName', from: 12, text: 'My Co', quote: '' }],
        ['NOT layer = my  cool L|', { kind: 'layerName', from: 12, text: 'my  cool L', quote: '' }],
        // A word alone is the prefix's value; a space, nothing begun yet.
        ['layer:My|', { kind: 'prefixValue', prefix: 'layer', from: 6, text: 'My', taken: [] }],
        ['layer:My |', { kind: 'term', from: 9, text: '' }],
        // Words that start no layer's name are what they read as.
        ['layer:Source AND fe|', { kind: 'term', from: 17, text: 'fe' }],
        ['layer: My Co|', { kind: 'term', from: 10, text: 'Co' }],
    ])("reads %s against the View's layers", (doc, expected) => {
        const [text, pos] = cursor(doc)
        expect(completionContextAt(text, pos, undefined, LAYERS.layers)).toEqual(expected)
    })

    it('offers a name that needs quotes after layer:, written in them', async () => {
        expect((await complete('layer:|', LAYERS))?.options.map((o) => [o.label, o.apply])).toEqual([
            ['Source', undefined], ['My Cool Layer', '"My Cool Layer"'], ["Bob's layer", `"Bob's layer"`],
            ['The "best" layer', `'The "best" layer'`]])
        expect((await complete('layer = |', LAYERS))?.options.map((o) => o.apply)).toEqual([
            'Source', '"My Cool Layer"', `"Bob's layer"`, `'The "best" layer'`])
    })

    it('offers the layers a name of several words starts, while it is typed, in quotes when picked', async () => {
        const r = await complete('layer:My Co|', LAYERS)
        expect(r?.from).toBe(6)
        expect(r?.options.map((o) => [o.label, o.apply])).toEqual([['My Cool Layer', '"My Cool Layer"']])
        expect(labels(await complete('NOT layer = my  cool l|', LAYERS))).toEqual(['My Cool Layer'])
        // Nothing unasked at a space; once no layer's name starts so, the
        // words are suggested as what they read as.
        expect(await complete('layer:My |', LAYERS)).toBeNull()
        expect(labels(await complete('layer:Source AND fe|', LAYERS))).toContain('feeds(…)')
    })

    it('offers the layers inside quotes, and closes the quote once', async () => {
        // One holding the quote begun can't be written in it.
        expect(labels(await complete('layer:"|', LAYERS))).toEqual(['Source', 'My Cool Layer', "Bob's layer"])
        expect(labels(await complete("layer = '|", LAYERS))).toEqual(['Source', 'My Cool Layer', 'The "best" layer'])
        // As typed, and with the quote closed for you.
        for (const doc of ['layer:"My|', 'layer:"My|"']) {
            const [text, pos] = cursor(doc)
            const view = new EditorView({ state: EditorState.create({ doc: text }) })
            const r = (await complete(doc, LAYERS))!
            const picked = r.options.find((o) => o.label === 'My Cool Layer')!
            ;(picked.apply as (v: EditorView, c: Completion, from: number, to: number) => void)(view, picked, r.from, pos)
            expect(view.state.doc.toString()).toBe('layer:"My Cool Layer"')
            expect(view.state.selection.main.head).toBe('layer:"My Cool Layer"'.length)
            view.destroy()
        }
    })

    it('colours and selects a name of several words as one', () => {
        const options = { layers: LAYERS.layers }
        const text = 'layer:My Cool Layer x'
        expect(dslRanges(text, options).map((r) => [text.slice(r.from, r.to), r.role])).toEqual([
            ['layer:', 'prefix'], ['My', 'value'], ['Cool', 'value'], ['Layer', 'value'], ['x', 'text']])
        const at = text.indexOf('Cool')
        expect(widerCondition(text, at, at, options)).toEqual({ from: 0, to: 'layer:My Cool Layer'.length })
        expect(conditionAtHead(text, 2, options)).toEqual({ from: 0, to: 'layer:My Cool Layer'.length })
    })
})


describe('dslLanguage — selecting a whole condition', () => {
    /** What a double-click at ``|`` selects whole — null where it selects a word. */
    const atHead = (doc: string) => {
        const [text, pos] = cursor(doc)
        const span = conditionAtHead(text, pos)
        return span && text.slice(span.from, span.to)
    }

    it.each([
        ['t|ag:PII type:dataset', 'tag:PII'],
        ['tag:PII ty|pe:dataset', 'type:dataset'],
        ['ou|tgoing[PRODUCES](type:dataset) AND tag:PII', 'outgoing[PRODUCES](type:dataset)'],
        ['type:x N|OT tag:PII', 'NOT tag:PII'],
        ['own|er = "Ann" tag:PII', 'owner = "Ann"'],
        ['notes IS N|OT EMPTY', 'notes IS NOT EMPTY'],
        ['type:x A|ND tag:PII', 'type:x AND tag:PII'],
        ['fedBy(type:x).v|ia(confidence >= 0.8)', 'fedBy(type:x).via(confidence >= 0.8)'],
        ['noIn|coming[PRODUCES] tag:PII', 'noIncoming[PRODUCES]'],
        ['ev|ery child(tag:PII)', 'every child(tag:PII)'],
    ])('a double-click on the start of a condition (%s) selects all of it', (doc, whole) => {
        expect(atHead(doc)).toBe(whole)
    })

    it('a double-click on any other word selects the word', () => {
        expect(atHead('tag:P|II')).toBeNull()
        expect(atHead('owner = "A|nn"')).toBeNull()
        expect(atHead('rev|enue')).toBeNull()
        expect(atHead('@"Fin|ance"')).toBeNull()
    })

    it('widens from the cursor a condition, then a group, at a time, out to the whole query', () => {
        const text = 'type:dataset AND (tag:PII OR owner IS SET)'
        const steps: string[] = []
        let from = text.indexOf('PII') + 1
        let to = from
        for (let span = widerCondition(text, from, to); span; span = widerCondition(text, from, to)) {
            ({ from, to } = span)
            steps.push(text.slice(from, to))
        }
        expect(steps).toEqual(['tag:PII', 'tag:PII OR owner IS SET', '(tag:PII OR owner IS SET)', text])
    })
})


describe('dslLanguage — an edge type named like a class', () => {
    const generic: DslVocabulary = { ...VOCAB, edgeTypes: [{ id: 'LINEAGE' }, { id: 'HAS', containment: true }] }

    it('completes it in quotes, so it is not read as the class', async () => {
        const r = await complete('outgoing[|', generic)
        expect(r?.options.find((o) => o.label === 'LINEAGE' && o.type === 'constant')?.apply).toBe('"LINEAGE"')
        // The class itself is still offered, bare.
        expect(r?.options.find((o) => o.label === 'lineage')?.apply).toBeUndefined()
    })

    it('warns only about a quoted name the data source lacks', () => {
        expect(dslDiagnostics('outgoing["LINEAGE"](type:x)', generic.edgeTypes)).toEqual([])
        expect(dslDiagnostics('outgoing["NOPE"](type:x)', generic.edgeTypes)).toEqual([
            expect.objectContaining({ severity: 'warning', from: 10, to: 14 })])
    })
})


describe('dslLanguage — connections', () => {
    it.each<[string, ReturnType<typeof completionContextAt>]>([
        // A connection's edges are any edges — a count's rules, not a relationship's.
        ['from(type:x) to[|', { kind: 'edgeType', from: 16, text: '', taken: [], connection: false }],
        ['from(type:x) linkedTo[PRODUCES, D|', { kind: 'edgeType', from: 32, text: 'D', taken: ['PRODUCES'],
            connection: false }],
        // linkedTo anywhere else is a relationship.
        ['linkedTo[|', { kind: 'edgeType', from: 9, text: '', taken: [], connection: true }],
        ['from(linkedTo[|', { kind: 'edgeType', from: 14, text: '', taken: [], connection: true }],
        // Right after from(…): where the edges go; inside an end, a condition.
        ['from(type:x) |', { kind: 'connectionEnd', from: 13, text: '' }],
        ['from(type:x) li|', { kind: 'connectionEnd', from: 13, text: 'li' }],
        ['from(type:x) to(ty|', { kind: 'term', from: 16, text: 'ty' }],
        ['from(|', { kind: 'term', from: 5, text: '' }],
        ['from(type:x) to(type:y).via(con|', { kind: 'edgeKey', from: 28, text: 'con' }],
    ])('reads %s', (doc, expected) => {
        const [text, pos] = cursor(doc)
        expect(completionContextAt(text, pos)).toEqual(expected)
    })

    it('offers where the edges go after from(…), unasked', async () => {
        expect(labels(await complete('from(type:x) |'))).toEqual(['to(…)', 'to[…](…)', 'linkedTo(…)'])
    })

    it('offers every class and edge type inside to[', async () => {
        expect(labels(await complete('from() to[|'))).toEqual(['lineage', 'links', 'any', 'containment',
            'PRODUCES', 'DEFINED_BY', 'CONTAINS'])
    })

    it('offers a whole connection to start a query with', async () => {
        expect(labels(await complete('fr|'))).toEqual(expect.arrayContaining(['from(…) to(…)', 'from(…) linkedTo(…)']))
    })

    it('warns about an edge type in to[…] that the data source lacks', () => {
        expect(dslDiagnostics('from() to[PRODUCE]()', VOCAB.edgeTypes).map((d) => d.message)).toEqual([
            "Edge type PRODUCE isn't in this data source"])
    })

    it('selects an end, then the whole connection', () => {
        const text = 'from(type:x) to[PRODUCES](tag:PII).via(rows > 5)'
        const fromWord = conditionAtHead(text, 1)
        expect(fromWord && text.slice(fromWord.from, fromWord.to)).toBe('from(type:x)')
        const toWord = conditionAtHead(text, text.indexOf('to[') + 1)
        expect(toWord && text.slice(toWord.from, toWord.to)).toBe('to[PRODUCES](tag:PII)')
        const wider = widerCondition(text, 0, 'from(type:x)'.length)
        expect(wider && text.slice(wider.from, wider.to)).toBe(text)
    })
})


describe('dslLanguage — operators, lists, durations and suffixes', () => {
    const KEYS = ['owner', 'Asset Owner', 'tier', 'updated']
    const keyField = (key: string, quoted: boolean) => comparedField(key, quoted, KEYS)
    const STATUS: DslVocabulary = { ...VOCAB, propertyKeys: [...VOCAB.propertyKeys, 'status', 'updated'] }

    it.each<[string, ReturnType<typeof completionContextAt>]>([
        ['owner |', { kind: 'operator', key: 'owner', quoted: false, field: 'property', from: 6, text: '' }],
        ['owner IS N|', { kind: 'operator', key: 'owner', quoted: false, field: 'property', from: 6, text: 'IS N' }],
        ['"Asset Owner" NOT I|', { kind: 'operator', key: 'Asset Owner', quoted: true, field: 'property', from: 14,
            text: 'NOT I' }],
        ['name |', { kind: 'operator', key: 'name', quoted: false, field: 'text', from: 5, text: '' }],
        ['type |', { kind: 'operator', key: 'type', quoted: false, field: 'type', from: 5, text: '' }],
        ['layer |', { kind: 'operator', key: 'layer', quoted: false, field: 'layer', from: 6, text: '' }],
        // A word that is no property, and an operator already written, are words.
        ['customer |', { kind: 'term', from: 9, text: '' }],
        ['owner IS SET |', { kind: 'term', from: 13, text: '' }],
        ['tier IN (gold, s|', { kind: 'value', key: 'tier', from: 15, text: 's', quoted: false, taken: ['gold'] }],
        ['tier NOT IN ("go|', { kind: 'value', key: 'tier', from: 14, text: 'go', quoted: true, taken: [] }],
        ['owner NOT CONTAINS fo|', { kind: 'value', key: 'owner', from: 19, text: 'fo', quoted: false }],
        ['updated WITHIN LAST 3|', { kind: 'duration', from: 20, text: '3' }],
        // A whole duration written, the next words follow.
        ['updated WITHIN LAST 30 days A|', { kind: 'term', from: 28, text: 'A' }],
        ['feeds(x).v|', { kind: 'via', from: 8, text: '.v' }],
    ])('reads %s', (doc, expected) => {
        const [text, pos] = cursor(doc)
        expect(completionContextAt(text, pos, keyField)).toEqual(expected)
    })

    it('offers every operator after a property, in the Form’s words, then what may come next', async () => {
        const r = await complete('status |', STATUS)
        expect(labels(r).slice(0, 20)).toEqual(['=', '!=', 'IN (…)', 'NOT IN (…)', '>', '>=', '<', '<=',
            'BETWEEN … AND …', 'CONTAINS …', 'NOT CONTAINS …', 'STARTS WITH …', 'ENDS WITH …',
            'CONTAINS ALL (…)', 'WITHIN LAST …', 'IS SET', 'IS NOT SET', 'IS EMPTY', 'IS NOT EMPTY', '= {…}'])
        const detail = (label: string) => r?.options.find((o) => o.label === label)?.detail
        expect([detail('IN (…)'), detail('NOT IN (…)'), detail('BETWEEN … AND …'), detail('WITHIN LAST …')])
            .toEqual(['is one of', 'is none of', 'is between', 'is within the last'])
        // A word in, the next condition may start there too; two words in, only operators.
        expect(labels(r)).toEqual(expect.arrayContaining(['type:', 'feeds(…)', 'status']))
        expect(labels(await complete('status IS N|', STATUS))).not.toContain('type:')
        // A quoted name is a property, whatever the view knows.
        expect(labels(await complete('"Cost Centre" |'))).toContain('IN (…)')
        // A name the view doesn't list: nothing unasked, its operators once one is begun or asked for.
        expect(await complete('customer |')).toBeNull()
        expect(labels(await complete('sourceSystem I|'))).toEqual(expect.arrayContaining(['IN (…)', 'IS SET',
            'inside @"…"']))
        expect(labels(await complete('sourceSystem |', VOCAB, true))).toContain('NOT IN (…)')
        // A word right after an operator is its value, whatever its name; so are the language's own words.
        expect(await complete('owner = status |', STATUS)).toBeNull()
        expect(labels(await complete('owner != x INCLUDING |'))).toEqual(['INCLUDING MISSING'])
    })

    it('offers the text operators after a text field, a list after type, and = after layer', async () => {
        expect(labels(await complete('name |')).slice(0, 4))
            .toEqual(['CONTAINS …', 'NOT CONTAINS …', 'STARTS WITH …', 'ENDS WITH …'])
        const type = await complete('type |')
        expect(type?.options.slice(0, 2).map((o) => [o.label, o.detail]))
            .toEqual([['IN (…)', 'its type is one of'], ['NOT IN (…)', 'its type is none of']])
        expect(labels(await complete('layer |'))[0]).toBe('=')
    })

    it('offers the values a list may hold, leaving out those listed', async () => {
        const suggestValues = vi.fn(async () => ({ values: [{ value: 'Active' }, { value: 'Demised' },
            { value: 'Suspended' }, { value: 'On hold' }, { value: '' }] }))
        const vocab = { ...STATUS, suggestValues }
        expect(labels(await complete('status IN (|', vocab))).toEqual(['Active', 'Demised', 'Suspended', 'On hold'])
        expect(suggestValues).toHaveBeenCalledWith('status', '')
        const next = await complete('status IN (Active, Demised, |', vocab)
        expect(next?.options.map((o) => [o.label, o.apply])).toEqual([['Suspended', 'Suspended'], ['On hold', '"On hold"']])
        expect(labels(await complete('status NOT IN ("Active", |', vocab))).not.toContain('Active')
        // The entity type takes the view's types, a layer its layers.
        const types = await complete('type IN (dataset, |')
        expect(types?.options.map((o) => [o.label, o.apply])).toEqual([['dashboard', 'dashboard'],
            ['data product', '"data product"']])
        expect(labels(await complete('layer = |'))).toEqual(['Source'])
    })

    it('offers how long after WITHIN LAST, and the edge filter after a relationship', async () => {
        expect(labels(await complete('updated WITHIN LAST |', STATUS)))
            .toEqual(['24 hours', '7 days', '30 days', '90 days', '6 months', '1 year'])
        expect(labels(await complete('feeds(type:dashboard).|'))).toEqual(['.via(…)'])
        expect(labels(await complete('from(type:x) to(type:y).v|'))).toEqual(['.via(…)'])
    })

    it('offers the suffixes a comparison takes, only where they change what it means', () => {
        const at = (head: string) => suffixOptions(head).map((o) => o.label)
        expect(at('owner != x ')).toEqual(['MATCH CASE', 'INCLUDING MISSING'])
        expect(at('owner = 15 ')).toEqual(['AS TEXT'])
        expect(at('created = 2024-05-01 ')).toEqual(['AS DATE', 'MATCH CASE'])
        expect(at('tier NOT IN (gold, silver) ')).toEqual(['MATCH CASE', 'INCLUDING MISSING'])
        expect(at('parent(owner != x ')).toEqual(['MATCH CASE', 'INCLUDING MISSING'])
        // Nothing after a condition that takes none, nor before a space.
        expect(at('owner IS SET ')).toEqual([])
        expect(at('tag:PII ')).toEqual([])
        expect(at('owner != x')).toEqual([])
    })

    it('completes a suffix begun, and offers them with the next words', async () => {
        const half = await complete('owner != x INCLUDING |')
        expect([half?.from, labels(half)]).toEqual([11, ['INCLUDING MISSING']])
        expect(labels(await complete('owner != x I|'))).toEqual(expect.arrayContaining(['INCLUDING MISSING',
            'MATCH CASE', 'type:']))
    })
})


describe('dslLanguage — Code mode offers everything it reads', () => {
    /** ``snippet`` with its fields filled in, as a person would. */
    const fill = (snippet: string, op: PropertyOperator) => snippet
        .replace('${1:low}', '1').replace('${2:high}', '9')
        .replace('${}', OPERATOR_TABLE[op].arity === 'many' ? 'a, b'
            : OPERATOR_TABLE[op].arity === 'duration' ? '30 days' : 'x')

    it('offers every operator the language has after a property, and each reads back as itself', async () => {
        expect(new Set(fieldOperators('property'))).toEqual(new Set(Object.keys(OPERATOR_TABLE)))
        const offered = labels(await complete('owner |'))
        for (const op of Object.keys(OPERATOR_TABLE) as PropertyOperator[]) {
            expect(offered.some((l) => l.startsWith(PROP_OP_STR[op])), op).toBe(true)
            const text = `owner ${fill(operatorSnippet(op), op)}`
            expect(parsePredicate(text).predicate, text).toMatchObject({ kind: 'property', key: 'owner', op })
        }
    })

    it('reads each operator it offers after a text field or type as that field’s condition', () => {
        for (const op of fieldOperators('text')) {
            expect(parsePredicate(`description ${fill(operatorSnippet(op), op)}`).predicate, op)
                .toMatchObject(op === 'notContains' ? { kind: 'group', op: 'not' } : { kind: 'text', target: 'description' })
        }
        expect(parsePredicate(`type ${fill(operatorSnippet('in'), 'in')}`).predicate)
            .toMatchObject({ kind: 'entityType', op: 'in', values: ['a', 'b'] })
    })

    it('offers every word the parser reads to start a condition with, bar older spellings', async () => {
        const offered = new Set(labels(await complete('x|', VOCAB, true)).map((l) => l.toLowerCase()))
        const older = new Set(['noupstreamlineage', 'nodownstreamlineage', 'orphan', 'orphans'])
        for (const word of Object.keys(SHAPE_WORDS).filter((w) => !older.has(w))) {
            expect(offered.has(word), word).toBe(true)
            expect(parsePredicate(word).tokens.map((t) => t.role), word).toEqual(['keyword'])
        }
        for (const word of Object.keys(RELATION_WORDS)) {
            expect([...offered].some((l) => l.startsWith(`${word}(`) || l.startsWith(`${word}[`)), word).toBe(true)
        }
        for (const word of ['type:', 'tag:', 'layer:', 'has:', 'qname:', 'description:', 'name contains',
            '@"…"', 'inside @"…"', 'every child(…)', 'no fedby(…)', 'count(…)', 'edges(…) >', 'ancestor*2(…)',
            'from(…) to(…)', 'from(…) linkedto(…)', 'and', 'or', 'not']) {
            expect(offered.has(word), word).toBe(true)
        }
    })
})
