/**
 * A question in plain words, read into a query — no model, rules over the
 * view's own words: its types, tags, properties, values and layers. The
 * table is the reader's contract: each row a question as people type it
 * and the query it reads as, in the query language (`stringifyPredicate`).
 */
import { describe, expect, it } from 'vitest'

import { stringifyPredicate } from '../../predicateDsl'
import { buildAskVocabulary } from '../askVocabulary'
import { interpretQuestion, type AskPicks } from '../interpretQuestion'


const vocab = buildAskVocabulary({
    entityTypes: [
        { id: 'dataPlatform', name: 'Data Platform', pluralName: 'Data Platforms' },
        { id: 'container', name: 'Container', pluralName: 'Containers' },
        { id: 'dataset', name: 'Dataset', pluralName: 'Datasets' },
        { id: 'schemaField', name: 'Column', pluralName: 'Columns' },
        { id: 'dashboard', name: 'Dashboard', pluralName: 'Dashboards' },
        { id: 'chart', name: 'Chart', pluralName: 'Charts' },
    ],
    tagValues: ['PII', 'GDPR', 'Finance', 'Certified', 'Deprecated'],
    propertyKeys: ['owner', 'rowCount', 'updatedAt', 'classification'],
    valueSamples: [
        { key: 'owner', value: 'finance-data@corp' }, { key: 'owner', value: 'sales-ops@corp' },
        { key: 'classification', value: 'confidential' }, { key: 'classification', value: 'public' },
    ],
    layers: [{ value: 'bronze', label: 'Bronze' }, { value: 'gold', label: 'Gold' }],
})

const read = (q: string, picks?: AskPicks) => interpretQuestion(q, vocab, picks)
const dsl = (q: string, picks?: AskPicks) => stringifyPredicate(read(q, picks).predicate)


describe('interpretQuestion — what it finds', () => {
    it.each([
        ['datasets', 'type:dataset'],
        ['Show me all the datasets.', 'type:dataset'],
        ['find datasets', 'type:dataset'],
        ['everything', ''],
        ['Datasets and dashboards', 'type:dataset,dashboard'],
        ['charts or dashboards', 'type:chart,dashboard'],
        ['columns', 'type:schemaField'],
        ['data platforms', 'type:dataPlatform'],
    ])('%s → %s', (q, out) => expect(dsl(q)).toBe(out))
})


describe('interpretQuestion — tags, shapes and documentation', () => {
    it.each([
        ['datasets tagged PII', 'type:dataset AND tag:PII'],
        ['#PII', 'tag:PII'],
        ['PII columns', 'type:schemaField AND tag:PII'],
        ['columns tagged PII or GDPR', 'type:schemaField AND tag:PII,GDPR'],
        ['datasets tagged PII and GDPR', 'type:dataset AND tag:PII AND tag:GDPR'],
        ['datasets not tagged PII', 'type:dataset AND NOT tag:PII'],
        ['datasets tagged sensitive', 'type:dataset AND tag:sensitive'],
        ['dead ends', 'noDownstream'],
        ['unused datasets', 'type:dataset AND noDownstream'],
        ['datasets with no downstream', 'type:dataset AND noDownstream'],
        ['orphaned columns', 'type:schemaField AND noLineage'],
        ['sources', 'noUpstream'],
        ['undocumented datasets', 'type:dataset AND not has:description'],
        ['unowned datasets', 'type:dataset AND not has:owner'],
    ])('%s → %s', (q, out) => expect(dsl(q)).toBe(out))
})


describe('interpretQuestion — relationships', () => {
    it.each([
        ['datasets that feed dashboards', 'type:dataset AND feeds*..3(type:dashboard)'],
        ['datasets feeding dashboards', 'type:dataset AND feeds*..3(type:dashboard)'],
        ['dashboards fed by datasets', 'type:dashboard AND fedBy*..3(type:dataset)'],
        ['which dashboards are fed by datasets', 'type:dashboard AND fedBy*..3(type:dataset)'],
        ['dashboards that read from datasets', 'type:dashboard AND fedBy*..3(type:dataset)'],
        ['datasets upstream of dashboards', 'type:dataset AND feeds*..3(type:dashboard)'],
        ['dashboards downstream of datasets', 'type:dashboard AND fedBy*..3(type:dataset)'],
        ['datasets linked to charts', 'type:dataset AND linkedTo[lineage]*..3(type:chart)'],
        ['datasets that feed finance dashboards', 'type:dataset AND feeds*..3(type:dashboard AND tag:Finance)'],
        ['datasets that feed dashboards that are tagged Finance',
            'type:dataset AND feeds*..3(type:dashboard AND tag:Finance)'],
        ['datasets that directly feed dashboards', 'type:dataset AND feeds(type:dashboard)'],
        ['datasets that feed dashboards directly', 'type:dataset AND feeds(type:dashboard)'],
        ['datasets that feed dashboards within 2 hops', 'type:dataset AND feeds*..2(type:dashboard)'],
        ['datasets that feed dashboards within 9 hops', 'type:dataset AND feeds*..9(type:dashboard)'],
        ['datasets that feed no dashboards', 'type:dataset AND no feeds*..3(type:dashboard)'],
        ['datasets that feed no dashboards within 9 hops', 'type:dataset AND no feeds*..3(type:dashboard)'],
        ['datasets that don\'t feed any dashboard', 'type:dataset AND no feeds*..3(type:dashboard)'],
        ['datasets that only feed dashboards', 'type:dataset AND every feeds*..3(type:dashboard)'],
        ['datasets that feed at least 2 dashboards', 'type:dataset AND count(feeds*..3(type:dashboard)) >= 2'],
        ['datasets that feed dashboards or charts', 'type:dataset AND feeds*..3(type:dashboard,chart)'],
        ['datasets that feed dashboards and are tagged PII',
            'type:dataset AND feeds*..3(type:dashboard) AND tag:PII'],
        ['datasets that feed dashboards or are tagged PII',
            'type:dataset AND (feeds*..3(type:dashboard) OR tag:PII)'],
        // A named relative takes in what is inside it, as right-click does.
        ['datasets that feed "CFO Revenue"',
            'type:dataset AND feeds*..3(@"**/CFO Revenue" OR ancestor(@"**/CFO Revenue"))'],
        ['datasets that feed "CFO Revenue" within 6 hops',
            'type:dataset AND feeds*..6(@"**/CFO Revenue" OR ancestor(@"**/CFO Revenue"))'],
        ['what depends on orders', 'fedBy*..3(@"**/orders" OR ancestor(@"**/orders"))'],
        ['datasets with more than 100 columns', 'type:dataset AND count(descendant(type:schemaField)) > 100'],
        ['containers containing columns tagged PII', 'type:container AND descendant(type:schemaField AND tag:PII)'],
        ['top-level containers', 'type:container AND no parent()'],
        ['datasets whose parent is a container', 'type:dataset AND parent(type:container)'],
        ['datasets with downstream dashboards', 'type:dataset AND feeds*..3(type:dashboard)'],
        ['datasets with more than 2 dashboards downstream',
            'type:dataset AND count(feeds*..3(type:dashboard)) > 2'],
        ['dashboards that feed nothing', 'type:dashboard AND no feeds*..3()'],
        ['what feeds the CFO dashboard', 'feeds*..3(type:dashboard AND CFO)'],
    ])('%s → %s', (q, out) => expect(dsl(q)).toBe(out))
})


const ORDERS = '@"**/orders" OR ancestor(@"**/orders")'

describe('interpretQuestion — the subject first', () => {
    it.each([
        // What it feeds: downstream of it.
        ['what does orders feed', `fedBy*..3(${ORDERS})`],
        ['What does orders feed into?', `fedBy*..3(${ORDERS})`],
        ['what does orders affect', `fedBy*..3(${ORDERS})`],
        ['what does orders impact', `fedBy*..3(${ORDERS})`],
        ['impact of orders', `fedBy*..3(${ORDERS})`],
        ['what is the impact of changing orders', `fedBy*..3(${ORDERS})`],
        ['what breaks if orders changes', `fedBy*..3(${ORDERS})`],
        ['what would break if I change orders', `fedBy*..3(${ORDERS})`],
        // What feeds it: upstream of it.
        ['where does orders come from', `feeds*..3(${ORDERS})`],
        ['where does orders get its data from?', `feeds*..3(${ORDERS})`],
        ['what does orders depend on', `feeds*..3(${ORDERS})`],
        ['what does orders use', `feeds*..3(${ORDERS})`],
        ['what does orders read from', `feeds*..3(${ORDERS})`],
        // How far, and which kind of answer.
        ['what does orders feed directly', `fedBy(${ORDERS})`],
        ['what does orders feed within 5 hops', `fedBy*..5(${ORDERS})`],
        ['which dashboards does orders feed', `type:dashboard AND fedBy*..3(${ORDERS})`],
        // A subject described rather than named.
        ['what do the finance dashboards depend on', 'feeds*..3(type:dashboard AND tag:Finance)'],
        // What it holds, what it is linked to.
        ['what does "Sales Ops" contain', 'ancestor(@"**/Sales Ops")'],
        ['what is orders linked to', `linkedTo[lineage]*..3(${ORDERS})`],
    ])('%s → %s', (q, out) => expect(dsl(q)).toBe(out))

    it('looks the subject up rather than searching its name, and offers "just it"', () => {
        const r = read('what does orders feed')
        expect(r.unrecognized).toEqual([])
        expect(r.names).toEqual([{ text: 'orders', ref: { path: ['**', 'orders'] } }])
        const [orders] = r.ambiguities
        expect(orders).toMatchObject({ id: '10:orders', text: 'orders', picked: 'withInside' })
        expect(orders.choices.map((c) => c.id)).toEqual(['withInside', 'itself'])
        expect(dsl('what does orders feed', { choices: { '10:orders': 'itself' } })).toBe('fedBy*..3(@"**/orders")')
    })

    it('offers "just it" for a relative named after the verb too', () => {
        const q = 'datasets that feed "CFO Revenue"'
        const [cfo] = read(q).ambiguities
        expect(cfo.choices.map((c) => c.id)).toEqual(['withInside', 'itself'])
        expect(dsl(q, { choices: { [cfo.id]: 'itself' } })).toBe('type:dataset AND feeds*..3(@"**/CFO Revenue")')
    })

    it('reads a question that names what it is about after the verb as it always did', () => {
        expect(dsl('what feeds the CFO dashboard')).toBe('feeds*..3(type:dashboard AND CFO)')
        expect(dsl('dashboards fed by datasets')).toBe('type:dashboard AND fedBy*..3(type:dataset)')
    })
})


describe('interpretQuestion — what it leaves out, and says so', () => {
    const vocabWith = (propertyKeys: string[]) => buildAskVocabulary({
        entityTypes: [{ id: 'dataset', name: 'Dataset', pluralName: 'Datasets' }],
        tagValues: [], propertyKeys, valueSamples: [], layers: [],
    })

    it('uses the view\'s own owner property', () => {
        const v = vocabWith(['dataOwner', 'rowCount'])
        expect(stringifyPredicate(interpretQuestion('unowned datasets', v).predicate))
            .toBe('type:dataset AND not has:dataOwner')
        expect(stringifyPredicate(interpretQuestion('datasets owned by alice', v).predicate))
            .toBe('type:dataset AND dataOwner = alice')
    })

    it('leaves out what needs an owner property in a view without one, and says so', () => {
        const v = vocabWith(['rowCount'])
        const unowned = interpretQuestion('unowned datasets', v)
        expect(stringifyPredicate(unowned.predicate)).toBe('type:dataset')
        expect(unowned.notes).toEqual(['This view has no owner property, so “unowned” was left out.'])
        const owned = interpretQuestion('datasets owned by alice', v)
        expect(stringifyPredicate(owned.predicate)).toBe('type:dataset')
        expect(owned.notes).toEqual(['This view has no owner property, so “owned by” was left out.'])
        expect(owned.unrecognized).toEqual([])
    })

    it('never reads "without" an unknown word as a name it doesn\'t contain', () => {
        const r = read('datasets without a steward')
        expect(stringifyPredicate(r.predicate)).toBe('type:dataset')
        expect(r.notes).toEqual(['This view has no property called “steward”, so that condition was left out.'])
        expect(r.unrecognized).toEqual([])
    })

    it('says when relationships nest deeper than a search reads', () => {
        const r = read('datasets that feed dashboards that feed charts that feed datasets that feed charts')
        expect(stringifyPredicate(r.predicate))
            .toBe('type:dataset AND feeds*..3(type:dashboard AND feeds*..3(type:chart AND feeds*..3(type:dataset)))')
        expect(r.notes).toEqual(['Relationships nest at most 3 deep, so the rest of the question was left out.'])
    })

    it('has nothing to say about a question it read whole', () => {
        expect(read('datasets that feed dashboards').notes).toEqual([])
    })
})


describe('interpretQuestion — inside a container', () => {
    it.each([
        ['datasets in Snowflake', 'type:dataset AND ancestor(@"**/Snowflake")'],
        ['datasets inside "Sales Ops"', 'type:dataset AND ancestor(@"**/Sales Ops")'],
        ['datasets not in RAW', 'type:dataset AND no ancestor(@"**/RAW")'],
        ['datasets that feed charts in Finance', 'type:dataset AND feeds*..3(type:chart AND ancestor(@"**/Finance"))'],
        ['datasets in the gold layer', 'type:dataset AND layer:gold'],
        ['datasets inside GOLD', 'type:dataset AND layer:gold'],
    ])('%s → %s', (q, out) => expect(dsl(q)).toBe(out))
})


describe('interpretQuestion — properties', () => {
    it.each([
        ['datasets owned by sales-ops@corp', 'type:dataset AND owner = sales-ops@corp'],
        ['datasets where owner is finance-data@corp', 'type:dataset AND owner = finance-data@corp'],
        ['datasets with row count over 1000', 'type:dataset AND rowCount > 1000'],
        ['datasets with more than 1M rows', 'type:dataset AND rowCount > 1000000'],
        ['datasets with fewer than 1,000 rows', 'type:dataset AND rowCount < 1000'],
        ['datasets with row count between 10 and 20', 'type:dataset AND rowCount BETWEEN (10, 20)'],
        ['datasets with an owner', 'type:dataset AND hasProperty:owner'],
        ['datasets without an owner', 'type:dataset AND not has:owner'],
        ['datasets updated in the last 7 days', 'type:dataset AND updatedAt WITHIN LAST 7 days'],
        ['datasets in the last 2 weeks', 'type:dataset AND updatedAt WITHIN LAST 14 days'],
        ['confidential datasets', 'type:dataset AND classification = confidential'],
        ['datasets with owner containing finance', 'type:dataset AND owner CONTAINS finance'],
    ])('%s → %s', (q, out) => expect(dsl(q)).toBe(out))
})


describe('interpretQuestion — names, and words it can\'t place', () => {
    it.each([
        ['orders', 'orders'],
        ['datasets named orders', 'type:dataset AND orders'],
        ['"customer orders"', '"customer orders"'],
        ['datasets foo bar', 'type:dataset AND "foo bar"'],
    ])('%s → %s', (q, out) => expect(dsl(q)).toBe(out))

    it('lists back the words it read as names', () => {
        expect(read('datasets foo bar').unrecognized).toEqual(['foo bar'])
        expect(read('datasets named orders').unrecognized).toEqual([])
    })

    it('reads nothing from nothing', () => {
        expect(read('').predicate).toBeNull()
        expect(read('show me all the').predicate).toBeNull()
    })
})


describe('interpretQuestion — adding to a query', () => {
    it('adds to the query when the question starts with "and"', () => {
        expect(read('and tagged PII')).toMatchObject({ mode: 'add' })
        expect(dsl('and tagged PII')).toBe('tag:PII')
        expect(read('also unused')).toMatchObject({ mode: 'add' })
        expect(read('datasets tagged PII').mode).toBe('replace')
    })
})


describe('interpretQuestion — a word with several readings', () => {
    it('offers the other readings of a word, and reads it as each one picked', () => {
        const first = read('finance dashboards')
        expect(stringifyPredicate(first.predicate)).toBe('type:dashboard AND tag:Finance')
        expect(first.ambiguities).toHaveLength(1)
        const [finance] = first.ambiguities
        expect(finance).toMatchObject({ text: 'finance', picked: 'tag' })
        expect(finance.choices.map((c) => c.id)).toEqual(['tag', 'inside', 'name'])

        expect(dsl('finance dashboards', { choices: { [finance.id]: 'inside' } }))
            .toBe('type:dashboard AND ancestor(@"**/finance")')
        expect(dsl('finance dashboards', { choices: { [finance.id]: 'name' } })).toBe('type:dashboard AND finance')
    })

    it('reads a layer\'s name inside a view with layers as the layer, a container on request', () => {
        const { ambiguities } = read('datasets inside GOLD')
        const gold = ambiguities.find((a) => a.text === 'GOLD')!
        expect(gold.choices.map((c) => c.id)).toEqual(['layer', 'inside'])
        expect(dsl('datasets inside GOLD', { choices: { [gold.id]: 'inside' } })).toBe('type:dataset AND ancestor(@"**/GOLD")')
    })

    it('offers to read a name as a container instead', () => {
        const [foo] = read('datasets foo bar').ambiguities
        expect(foo.choices.map((c) => c.id)).toEqual(['name', 'inside'])
        expect(dsl('datasets foo bar', { choices: { [foo.id]: 'inside' } })).toBe('type:dataset AND ancestor(@"**/foo bar")')
    })

    it('reads the same question the same way every time', () => {
        expect(read('datasets that feed finance dashboards')).toEqual(read('datasets that feed finance dashboards'))
    })
})


describe('interpretQuestion — the names a question points at', () => {
    it('collects each named entity once, to be looked up', () => {
        const { names } = read('charts in Snowflake fed by datasets in Snowflake that feed "CFO Revenue"')
        expect(names.map((n) => n.text)).toEqual(['Snowflake', 'CFO Revenue'])
    })

    it('uses the entity picked for a name', () => {
        const ref = { path: ['Tableau', 'Finance'] }
        expect(dsl('charts in Finance', { names: { Finance: ref } }))
            .toBe('type:chart AND ancestor(@"Tableau/Finance")')
    })
})


describe('interpretQuestion — what flows from one place to another', () => {
    it.each([
        ['what flows from bronze to gold', 'from(layer:bronze) to[lineage](layer:gold)'],
        ['what flows from the bronze layer to the gold layer', 'from(layer:bronze) to[lineage](layer:gold)'],
        ['what data moves from datasets to dashboards?', 'from(type:dataset) to[lineage](type:dashboard)'],
        ['connections between datasets and dashboards', 'from(type:dataset) linkedTo(type:dashboard)'],
        ['the links between PII columns and charts', 'from(type:schemaField AND tag:PII) linkedTo(type:chart)'],
    ])('%s → %s', (q, out) => {
        const r = read(q)
        expect(stringifyPredicate(r.predicate)).toBe(out)
        expect(r.mode).toBe('replace')
        expect(r.unrecognized).toEqual([])
    })

    it('reads a named place as it and what is inside it, and offers just it', () => {
        const r = read('what flows from Sales to dashboards')
        expect(stringifyPredicate(r.predicate)).toBe('from(@"**/Sales" OR ancestor(@"**/Sales")) to[lineage](type:dashboard)')
        expect(r.names.map((n) => n.text)).toEqual(['Sales'])
        const [sales] = r.ambiguities
        expect(sales.choices.map((c) => c.id)).toEqual(['withInside', 'itself'])
        expect(dsl('what flows from Sales to dashboards', { choices: { [sales.id]: 'itself' } }))
            .toBe('from(@"**/Sales") to[lineage](type:dashboard)')
    })
})


describe('interpretQuestion — routes', () => {
    const route = (q: string) => read(q).predicate

    it('reads how one thing reaches another as the routes from it, downstream', () => {
        expect(route('how does orders reach revenue')).toEqual({
            kind: 'path', sourceUrns: [], targetUrns: [], direction: 'outgoing', edgeClass: 'lineage', maxHops: 4,
            sourceRefs: [{ path: ['**', 'orders'] }], targetRefs: [{ path: ['**', 'revenue'] }],
        })
        expect(read('how does orders reach revenue').names.map((n) => n.text)).toEqual(['orders', 'revenue'])
        expect(route('show me the paths from orders to dashboards')).toMatchObject({
            kind: 'path', direction: 'outgoing', sourceRefs: [{ path: ['**', 'orders'] }],
            targetWhere: { kind: 'entityType', op: 'in', values: ['dashboard'] },
        })
    })

    it('reads two things connected, or the routes between them, either way', () => {
        expect(route('how is orders connected to revenue')).toMatchObject({ kind: 'path', direction: 'any' })
        // Two conditions for ends: as far as the server goes for both, three hops.
        expect(route('routes between datasets tagged PII and dashboards')).toMatchObject({
            kind: 'path', direction: 'any', maxHops: 3,
            sourceWhere: { kind: 'group', op: 'and', children: [
                { kind: 'entityType', op: 'in', values: ['dataset'] }, { kind: 'tag', op: 'hasAny', values: ['PII'] }] },
            targetWhere: { kind: 'entityType', op: 'in', values: ['dashboard'] },
        })
    })

    it('reads anything else as it always did', () => {
        expect(route('how many datasets')?.kind).not.toBe('path')
        expect(route('datasets in the path folder')?.kind).not.toBe('path')
    })
})


describe('interpretQuestion — a layer, and the words catalogs use', () => {
    it('reads "the gold layer" as the layer, the others a click away', () => {
        const r = read('the gold layer')
        expect(stringifyPredicate(r.predicate)).toBe('layer:gold')
        expect(r.ambiguities[0].choices.map((c) => c.id)).toEqual(['layer', 'inside', 'name'])
    })

    it('reads a catalog\'s word as the view\'s own type: tables are its datasets, fields its columns', () => {
        expect(dsl('tables tagged PII')).toBe('type:dataset AND tag:PII')
        const fields = buildAskVocabulary({ entityTypes: [{ id: 'schemaField', name: 'Schema field' }],
            tagValues: [], propertyKeys: [], valueSamples: [], layers: [] })
        expect(stringifyPredicate(interpretQuestion('fields', fields).predicate)).toBe('type:schemaField')
    })

    it('maps a catalog\'s word only to a type the view holds, and never over its own', () => {
        const without = buildAskVocabulary({ entityTypes: [{ id: 'dataset' }], tagValues: [], propertyKeys: [],
            valueSamples: [], layers: [], presentTypes: ['dashboard'] })
        expect(stringifyPredicate(interpretQuestion('tables', without).predicate)).toBe('tables')
        const own = buildAskVocabulary({ entityTypes: [{ id: 'dataset' }, { id: 'table' }], tagValues: [],
            propertyKeys: [], valueSamples: [], layers: [] })
        expect(stringifyPredicate(interpretQuestion('tables', own).predicate)).toBe('type:table')
    })
})


describe('interpretQuestion — did you mean', () => {
    it('offers the view\'s word a typed one is a letter or two off', () => {
        expect(read('dashbaords').suggestions).toEqual([{ text: 'dashbaords', suggestion: 'dashboards' }])
        expect(read('datasets tagged pij').suggestions).toEqual([{ text: 'pij', suggestion: 'PII' }])
    })

    it('offers nothing for a word it read, or one nothing is close to', () => {
        expect(read('datasets tagged PII').suggestions).toEqual([])
        expect(read('zebra').suggestions).toEqual([])
    })
})


describe('interpretQuestion — connections', () => {
    const edgeVocab = buildAskVocabulary({
        entityTypes: [
            { id: 'dataset', name: 'Dataset', pluralName: 'Datasets' },
            { id: 'schemaField', name: 'Column', pluralName: 'Columns' },
            { id: 'dashboard', name: 'Dashboard', pluralName: 'Dashboards' },
            { id: 'chart', name: 'Chart', pluralName: 'Charts' },
        ],
        tagValues: ['PII', 'Finance'],
        propertyKeys: ['owner'],
        valueSamples: [],
        layers: [{ value: 'gold', label: 'Gold' }],
        edgeTypes: ['PRODUCES', 'DEFINED_BY', 'TRANSFORMS', 'CONTAINS'],
    })
    const ask = (q: string) => interpretQuestion(q, edgeVocab)

    it.each([
        ['connections from columns tagged PII to dashboards', 'from(type:schemaField AND tag:PII) to(type:dashboard)'],
        ['Show me all the edges from datasets to charts.', 'from(type:dataset) to(type:chart)'],
        ['links from datasets to dashboards either way', 'from(type:dataset) linkedTo(type:dashboard)'],
        ['relationships from columns to datasets through produces', 'from(type:schemaField) to[PRODUCES](type:dataset)'],
        ['connections from datasets to anything through defined by edges', 'from(type:dataset) to[DEFINED_BY]()'],
        ['connections from anything to the gold layer', 'from() to(layer:gold)'],
        ['connections from anything inside Finance to dashboards', 'from(ancestor(@"**/Finance")) to(type:dashboard)'],
        ['connections from datasets to charts through lineage', 'from(type:dataset) to[lineage](type:chart)'],
        ['edges from columns to columns through transforms and produces, either way',
            'from(type:schemaField) linkedTo[TRANSFORMS, PRODUCES](type:schemaField)'],
    ])('%s → %s', (q, out) => {
        const r = ask(q)
        expect(stringifyPredicate(r.predicate)).toBe(out)
        expect(r.mode).toBe('replace')
        expect(r.unrecognized).toEqual([])
    })

    it('ends From at the "to" that leaves the fewest words unread', () => {
        expect(stringifyPredicate(ask('connections from datasets linked to dashboards to charts').predicate))
            .toBe('from(type:dataset AND linkedTo[lineage]*..3(type:dashboard)) to(type:chart)')
    })

    it('says back what "through …" names that is no edge type here', () => {
        const r = ask('connections from datasets to charts through whatever')
        expect(stringifyPredicate(r.predicate)).toBe('from(type:dataset) to(type:chart)')
        expect(r.unrecognized).toEqual(['whatever'])
    })

    it('keeps each word\'s place in the question, so a pick sticks to it', () => {
        const q = 'connections from finance to dashboards'
        expect(ask(q).ambiguities.map((a) => a.id)).toEqual(['17:finance'])
        expect(stringifyPredicate(interpretQuestion(q, edgeVocab, { choices: { '17:finance': 'name' } }).predicate))
            .toBe('from(finance) to(type:dashboard)')
    })

    it('reads anything else as it always did', () => {
        expect(ask('links from finance').predicate?.kind).not.toBe('edges')
        expect(ask('and connections from datasets to charts').predicate?.kind).not.toBe('edges')
        expect(ask('datasets that feed dashboards').predicate?.kind).not.toBe('edges')
    })
})
