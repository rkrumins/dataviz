/**
 * Which of an any-of query's alternatives a row meets — read from the row
 * itself, or from the server's account of the text it matched; nothing
 * said for an all-of query, or for a line the row can't speak for.
 */
import { describe, expect, it } from 'vitest'

import type { Predicate, SearchHit } from '@/types/search'

import { whyItMatched } from '../whyItMatched'


const type = (...values: string[]): Predicate => ({ kind: 'entityType', op: 'in', values })
const tag = (...values: string[]): Predicate => ({ kind: 'tag', op: 'hasAny', values })
const all = (...children: Predicate[]): Predicate => ({ kind: 'group', op: 'and', children })
const any = (...children: Predicate[]): Predicate => ({ kind: 'group', op: 'or', children })
const name = (value: string) => ({ kind: 'text', value, target: 'name', match: 'substring' } as Predicate)

const hit = (over: Partial<SearchHit['node']> = {}, matchedPredicates?: number[]): SearchHit => ({
    node: { urn: 'u', displayName: 'orders', entityType: 'dataset', tags: [], properties: {}, ...over },
    matchedPredicates,
} as SearchHit)


describe('whyItMatched', () => {
    it('names the alternatives a row meets, by its own type, tags and properties', () => {
        const q = any(tag('PII'), { kind: 'hasProperty', key: 'owner' }, type('chart'))
        expect(whyItMatched(q, hit({ tags: ['pii'] }))).toEqual([0])
        expect(whyItMatched(q, hit({ properties: { owner: 'a' }, entityType: 'chart' }))).toEqual([1, 2])
    })

    it('counts the subject first, as the Sentence lists the lines', () => {
        const q = all(type('dataset'), any(tag('PII'), tag('GDPR')))
        expect(whyItMatched(q, hit({ tags: ['GDPR'] }))).toEqual([2])
    })

    it('takes the server\'s word for the text a row matched', () => {
        // Leaves numbered depth first: tag:x is 0, name "ord" is 1.
        const q = any(tag('x'), name('ord'))
        expect(whyItMatched(q, hit({}, [1]))).toEqual([1])
        expect(whyItMatched(q, hit({}, []))).toEqual([])
    })

    it('says nothing for an all-of query, or a line the row can\'t speak for', () => {
        expect(whyItMatched(all(tag('PII'), type('dataset')), hit({ tags: ['PII'] }))).toEqual([])
        expect(whyItMatched(any({ kind: 'isLeaf' }, { kind: 'related', axis: 'parent' }), hit())).toEqual([])
    })
})
