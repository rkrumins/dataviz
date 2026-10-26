/**
 * Recipes in a view's own words — and only those it can use: one naming a
 * type, tag or key the view doesn't have isn't offered there.
 */
import { describe, expect, it } from 'vitest'

import { isRowIncomplete } from '../../ConditionRow'
import { whyUncountable } from '../../counts/countable'
import { recipesFor, startingRecipes, type RecipeView } from '../recipes'


const NAMES: Record<string, [string, string]> = {
    dataset: ['Dataset', 'Datasets'], dashboard: ['Dashboard', 'Dashboards'], schemaField: ['Column', 'Columns'],
}
const typeName = (t: string, plural?: boolean) => NAMES[t]?.[plural ? 1 : 0] ?? (plural ? `${t}s` : t)

const FULL: RecipeView = {
    types: ['schemaField', 'dataset', 'container', 'dashboard', 'chart'],
    tags: ['Certified', 'PII', 'Finance', 'GDPR', 'Deprecated'],
    keys: ['owner', 'description', 'rowCount'],
    layers: [{ value: 'raw', label: 'Raw' }, { value: 'gold', label: 'Gold' }],
}

const titles = (view: RecipeView) => Object.fromEntries(recipesFor(view, typeName).map((r) => [r.id, r.title]))


describe('recipesFor', () => {
    it('puts every recipe in the view\'s own words', () => {
        expect(titles(FULL)).toEqual({
            'feeds-from-one': 'Everything one entity feeds',
            'built-on-sensitive': 'Dashboards built on PII or GDPR data',
            'widely-read': 'Datasets that feed 3 or more others',
            'feeding-one': 'Everything that feeds one entity',
            'feeds-consumers': 'Datasets that feed dashboards',
            'lineage-starts': 'Where lineage starts',
            route: 'How one entity reaches another',
            sensitive: 'Everything tagged PII or GDPR',
            'holding-sensitive': 'Datasets holding PII or GDPR data',
            unclassified: 'Datasets with no PII or GDPR tag',
            undocumented: 'Datasets without a description',
            'undocumented-fields': 'Columns without a description',
            unowned: 'Datasets without an owner',
            'owned-by': 'Everything one person owns',
            'sensitive-unowned': 'PII or GDPR data without an owner',
            'no-lineage': 'Datasets with no lineage at all',
            'no-links': 'Datasets nothing links to',
            'dead-ends': 'Datasets nothing reads from',
            'deprecated-in-use': 'Tagged Deprecated, but still feeding something',
            'all-of-type': 'All datasets',
            'by-name': 'Find something by name',
            'inside-one': 'Everything inside one container',
            'linked-to-one': 'Everything linked to one entity',
            'in-layer': 'Everything in the Raw layer',
            tagged: 'Everything tagged Certified',
        })
    })

    it('offers only what the view can answer', () => {
        expect(Object.keys(titles({ types: ['chart'], tags: [], keys: [], layers: [] }))).toEqual([
            'feeds-from-one', 'feeding-one', 'lineage-starts', 'route', 'no-lineage', 'no-links', 'dead-ends',
            'all-of-type', 'by-name', 'inside-one', 'linked-to-one',
        ])
        expect(titles({ types: ['chart'], tags: [], keys: [], layers: [] })['all-of-type']).toBe('All charts')
    })

    it('builds each from the view\'s words', () => {
        const by = Object.fromEntries(recipesFor(FULL, typeName).map((r) => [r.id, r.predicate]))
        expect(by['feeds-consumers']).toEqual({ kind: 'group', op: 'and', children: [
            { kind: 'entityType', op: 'in', values: ['dataset'] },
            { kind: 'related', axis: 'downstream', maxHops: 3, where: { kind: 'entityType', op: 'in', values: ['dashboard'] } },
        ] })
        expect(by.unclassified).toEqual({ kind: 'group', op: 'and', children: [
            { kind: 'entityType', op: 'in', values: ['dataset'] }, { kind: 'tag', op: 'notHas', values: ['PII', 'GDPR'] },
        ] })
        // Every link, either way: lineage, tags, terms and the rest.
        expect(by['no-links']).toEqual({ kind: 'group', op: 'and', children: [
            { kind: 'entityType', op: 'in', values: ['dataset'] }, { kind: 'isOrphan', edgeClass: 'links' },
        ] })
        expect(by['linked-to-one']).toEqual({ kind: 'related', axis: 'neighbor', edgeClass: 'links',
            where: { kind: 'is', refs: [] } })
        // An owner by another name is still the owner.
        const other = recipesFor({ ...FULL, keys: ['dataOwner'] }, typeName).find((r) => r.id === 'unowned')
        expect(other?.predicate).toEqual({ kind: 'group', op: 'and', children: [
            { kind: 'entityType', op: 'in', values: ['dataset'] }, { kind: 'hasProperty', key: 'dataOwner', negate: true },
        ] })
    })

    it('counts every recipe ready to run, and leaves a blank to fill in on the others', () => {
        for (const r of recipesFor(FULL, typeName)) {
            if (r.blank) {
                expect(whyUncountable(r.predicate), r.id).not.toBeNull()
            } else {
                expect(whyUncountable(r.predicate), r.id).toBeNull()
                expect(isRowIncomplete(r.predicate), r.id).toBe(false)
            }
        }
    })
})


describe('startingRecipes', () => {
    it('takes the first ready-to-run recipe of each intent', () => {
        expect(startingRecipes(recipesFor(FULL, typeName), 5).map((r) => r.id))
            .toEqual(['widely-read', 'feeds-consumers', 'sensitive', 'undocumented', 'unowned'])
        expect(startingRecipes(recipesFor({ types: [], tags: [], keys: [], layers: [] }, typeName), 5).map((r) => r.id))
            .toEqual(['lineage-starts', 'no-lineage'])
    })
})
