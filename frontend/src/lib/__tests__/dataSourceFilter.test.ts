/**
 * The Sources filter: words find a source by name, description (its own, else the catalog's)
 * or tag, every word must match; a tag matches in any letters; sensitivity and status match
 * exactly; and the bar is worth showing past six sources or once anything is tagged.
 */
import { describe, expect, it } from 'vitest'
import { NO_FILTER, filterDataSources, isFiltering, wantsFilterBar } from '../dataSourceFilter'
import { countTags, rankTags } from '../tags'

const src = (label: string, over: Record<string, unknown> = {}) => ({
    label, description: null, catalogDescription: null, tags: [] as string[], classification: null, trustStatus: null, ...over,
}) as Parameters<typeof filterDataSources>[0][number]

const GL = src('General Ledger', { description: 'Balances and journals', tags: ['Finance', 'month-end'], classification: 'confidential', trustStatus: 'certified' })
const RISK = src('Risk Models', { catalogDescription: 'VaR and stress models', tags: ['risk'] })
const REG = src('Regulatory Reporting', { tags: ['finance'], trustStatus: 'deprecated' })
const ALL = [GL, RISK, REG]
const labels = (xs: { label?: string }[]) => xs.map(x => x.label)

describe('filterDataSources', () => {
    it('passes everything through with no filter', () => {
        expect(filterDataSources(ALL, NO_FILTER)).toEqual(ALL)
        expect(isFiltering(NO_FILTER)).toBe(false)
    })

    it('finds words in the name, the description (or the catalog’s) and the tags — all of them', () => {
        expect(labels(filterDataSources(ALL, { ...NO_FILTER, text: 'journals' }))).toEqual(['General Ledger'])
        expect(labels(filterDataSources(ALL, { ...NO_FILTER, text: 'stress' }))).toEqual(['Risk Models'])
        expect(labels(filterDataSources(ALL, { ...NO_FILTER, text: 'FINANCE' }))).toEqual(['General Ledger', 'Regulatory Reporting'])
        expect(labels(filterDataSources(ALL, { ...NO_FILTER, text: 'finance month' }))).toEqual(['General Ledger'])
        expect(filterDataSources(ALL, { ...NO_FILTER, text: 'nothing like it' })).toEqual([])
    })

    it('names an unlabelled source as the caller does', () => {
        const unnamed = src('', { label: undefined })
        expect(filterDataSources([unnamed], { ...NO_FILTER, text: 'orders' }, () => 'Orders graph')).toEqual([unnamed])
    })

    it('matches a tag in any letters, and sensitivity and status exactly — together', () => {
        expect(labels(filterDataSources(ALL, { ...NO_FILTER, tag: 'finance' }))).toEqual(['General Ledger', 'Regulatory Reporting'])
        expect(labels(filterDataSources(ALL, { ...NO_FILTER, classification: 'confidential' }))).toEqual(['General Ledger'])
        expect(labels(filterDataSources(ALL, { ...NO_FILTER, trustStatus: 'deprecated' }))).toEqual(['Regulatory Reporting'])
        expect(filterDataSources(ALL, { ...NO_FILTER, tag: 'finance', trustStatus: 'in_review' })).toEqual([])
        expect(isFiltering({ ...NO_FILTER, tag: 'finance' })).toBe(true)
    })
})

describe('wantsFilterBar', () => {
    it('wants one once anything is tagged, or past six sources', () => {
        expect(wantsFilterBar([src('a'), src('b')])).toBe(false)
        expect(wantsFilterBar([src('a'), src('b', { tags: ['x'] })])).toBe(true)
        expect(wantsFilterBar(Array.from({ length: 7 }, (_, i) => src(`s${i}`)))).toBe(true)
    })
})

describe('tags', () => {
    it('counts tags across lists in any letters, most used first, in the spelling first seen', () => {
        expect(countTags([GL.tags, REG.tags, RISK.tags, null])).toEqual([
            { tag: 'Finance', count: 2 }, { tag: 'month-end', count: 1 }, { tag: 'risk', count: 1 },
        ])
        expect(rankTags([['b', 'a'], ['a']])).toEqual(['a', 'b'])
    })
})
