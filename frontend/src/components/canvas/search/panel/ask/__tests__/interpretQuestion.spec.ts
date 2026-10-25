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
        ['datasets that feed dashboards within 9 hops', 'type:dataset AND feeds*..3(type:dashboard)'],
        ['datasets that feed no dashboards', 'type:dataset AND no feeds*..3(type:dashboard)'],
        ['datasets that don\'t feed any dashboard', 'type:dataset AND no feeds*..3(type:dashboard)'],
        ['datasets that only feed dashboards', 'type:dataset AND every feeds*..3(type:dashboard)'],
        ['datasets that feed at least 2 dashboards', 'type:dataset AND count(feeds*..3(type:dashboard)) >= 2'],
        ['datasets that feed dashboards or charts', 'type:dataset AND feeds*..3(type:dashboard,chart)'],
        ['datasets that feed dashboards and are tagged PII',
            'type:dataset AND feeds*..3(type:dashboard) AND tag:PII'],
        ['datasets that feed dashboards or are tagged PII',
            'type:dataset AND (feeds*..3(type:dashboard) OR tag:PII)'],
        ['datasets that feed "CFO Revenue"', 'type:dataset AND feeds*..3(@"**/CFO Revenue")'],
        ['datasets that feed "CFO Revenue" within 6 hops', 'type:dataset AND feeds*..6(@"**/CFO Revenue")'],
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
