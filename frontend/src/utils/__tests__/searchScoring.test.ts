import { describe, expect, it } from 'vitest'
import { scoreCandidate, scoreCandidates, type FieldSpec } from '../searchScoring'

interface Item {
    name: string
    description?: string | null
    tags?: string[]
}

const NAME_ONLY: FieldSpec<Item>[] = [{ get: i => i.name, weight: 1.0 }]

const FULL: FieldSpec<Item>[] = [
    { get: i => i.name, weight: 1.0 },
    { get: i => i.description, weight: 0.4 },
    { get: i => i.tags, weight: 0.6 },
]

describe('scoreCandidate', () => {
    it('returns 100 * weight for an exact match', () => {
        expect(scoreCandidate({ name: 'sales' }, 'sales', NAME_ONLY)).toBe(100)
    })

    it('returns 60 * weight for a prefix match', () => {
        expect(scoreCandidate({ name: 'sales pipeline' }, 'sales', NAME_ONLY)).toBe(60)
    })

    it('returns 40 * weight for a word-boundary match', () => {
        expect(scoreCandidate({ name: 'monthly sales report' }, 'sales', NAME_ONLY)).toBe(40)
    })

    it('returns 20 * weight for a substring match inside a word', () => {
        expect(scoreCandidate({ name: 'wholesales' }, 'sales', NAME_ONLY)).toBe(20)
    })

    it('returns 0 for no match', () => {
        expect(scoreCandidate({ name: 'finance' }, 'sales', NAME_ONLY)).toBe(0)
    })

    it('is case-insensitive (caller passes lowercased query, fields lowercased internally)', () => {
        expect(scoreCandidate({ name: 'Sales' }, 'sales', NAME_ONLY)).toBe(100)
        expect(scoreCandidate({ name: 'SALES PIPELINE' }, 'sales', NAME_ONLY)).toBe(60)
    })

    it('skips null/undefined fields without crashing', () => {
        expect(scoreCandidate({ name: 'finance', description: null }, 'sales', FULL)).toBe(0)
        expect(scoreCandidate({ name: 'finance' }, 'sales', FULL)).toBe(0)
    })

    it('takes the best per-element match for array fields (tags)', () => {
        const item: Item = { name: 'finance', tags: ['quarterly', 'sales-funnel', 'q4'] }
        // best tag match is "sales-funnel" → prefix match (60) * 0.6 = 36
        expect(scoreCandidate(item, 'sales', FULL)).toBe(60 * 0.6)
    })

    it('sums across multiple matching fields with their weights', () => {
        const item: Item = { name: 'sales report', description: 'monthly sales numbers' }
        // name: prefix 60 * 1.0 = 60
        // description: word-boundary 40 * 0.4 = 16
        expect(scoreCandidate(item, 'sales', FULL)).toBe(60 + 16)
    })

    it('weights name above description by orders of magnitude', () => {
        const a: Item = { name: 'sales report' } // prefix on name = 60
        const b: Item = { name: 'finance', description: 'sales blurb' } // prefix on desc = 60 * 0.4 = 24
        expect(scoreCandidate(a, 'sales', FULL)).toBeGreaterThan(scoreCandidate(b, 'sales', FULL))
    })
})

describe('scoreCandidates', () => {
    it('drops zero-score candidates and sorts descending by score', () => {
        const candidates: Item[] = [
            { name: 'finance' }, // 0 — dropped
            { name: 'wholesales' }, // 20 substring
            { name: 'sales' }, // 100 exact
            { name: 'sales pipeline' }, // 60 prefix
            { name: 'monthly sales' }, // 40 word boundary
        ]
        const result = scoreCandidates(candidates, 'sales', NAME_ONLY)
        expect(result.map(r => r.item.name)).toEqual([
            'sales',           // 100
            'sales pipeline',  //  60
            'monthly sales',   //  40
            'wholesales',      //  20
        ])
    })

    it('returns empty array for an empty/whitespace query', () => {
        expect(scoreCandidates([{ name: 'sales' }], '', NAME_ONLY)).toEqual([])
        expect(scoreCandidates([{ name: 'sales' }], '   ', NAME_ONLY)).toEqual([])
    })

    it('preserves input order for tied scores (stable)', () => {
        const candidates: Item[] = [
            { name: 'sales A' },
            { name: 'sales B' },
            { name: 'sales C' },
        ]
        const result = scoreCandidates(candidates, 'sales', NAME_ONLY)
        expect(result.map(r => r.item.name)).toEqual(['sales A', 'sales B', 'sales C'])
    })

    it('trims and lowercases the query', () => {
        const result = scoreCandidates([{ name: 'Sales Pipeline' }], '  SALES  ', NAME_ONLY)
        expect(result).toHaveLength(1)
        expect(result[0].score).toBe(60)
    })

    describe('tokenised multi-word queries', () => {
        it('finds a candidate whose words are out of query order (AND of tokens)', () => {
            // tokens: 'pipeline' (word-boundary=40), 'sales' (prefix=60); phrase 'pipeline sales'
            // doesn't occur literally, so this is a pure token-AND match.
            const result = scoreCandidates([{ name: 'Sales Pipeline Q4' }], 'pipeline sales', NAME_ONLY)
            expect(result).toHaveLength(1)
            expect(result[0].item.name).toBe('Sales Pipeline Q4')
            expect(result[0].score).toBe(100) // 0 (no literal phrase) + 40 + 60
        })

        it('ranks a literal phrase match above a token-only match with the same token sum', () => {
            const candidates: Item[] = [
                { name: 'Pipeline Sales Data' }, // tokens only: sales=40 (word-boundary) + pipeline=60 (prefix) = 100
                { name: 'Sales Pipeline Q4' }, // phrase 'sales pipeline' is a literal prefix (60) on top of the same 100
            ]
            const result = scoreCandidates(candidates, 'sales pipeline', NAME_ONLY)
            expect(result.map(r => r.item.name)).toEqual(['Sales Pipeline Q4', 'Pipeline Sales Data'])
            expect(result[0].score).toBe(160) // 60 (phrase prefix) + 60 (sales prefix) + 40 (pipeline word-boundary)
            expect(result[1].score).toBe(100) // 0 (no literal phrase) + 40 (sales word-boundary) + 60 (pipeline prefix)
        })

        it('drops a candidate that matches only one of the tokens (AND, not OR)', () => {
            const candidates: Item[] = [
                { name: 'Sales Report' }, // matches 'sales', not 'pipeline' → dropped
                { name: 'Sales Pipeline' }, // matches both → kept
            ]
            const result = scoreCandidates(candidates, 'sales pipeline', NAME_ONLY)
            expect(result.map(r => r.item.name)).toEqual(['Sales Pipeline'])
        })

        it('requires each token to match, even when different tokens hit different fields', () => {
            // 'sales' only matches description; 'pipeline' only matches description too — but
            // spread across the FULL field set, not both required to hit the same single field.
            const item: Item = { name: 'Q4 Report', description: 'sales pipeline summary' }
            const other: Item = { name: 'Q4 Report', description: 'sales figures only' } // no 'pipeline' anywhere → dropped
            const result = scoreCandidates([item, other], 'sales pipeline', FULL)
            expect(result.map(r => r.item.description)).toEqual(['sales pipeline summary'])
            // phrase 'sales pipeline' is a prefix of description (60*0.4=24)
            // + sales prefix (60*0.4=24) + pipeline word-boundary (40*0.4=16)
            expect(result[0].score).toBe(24 + 24 + 16)
        })

        it('collapses to the single-token path for one-word queries (unchanged behaviour)', () => {
            const result = scoreCandidates([{ name: 'Sales Pipeline' }], 'sales', NAME_ONLY)
            expect(result[0].score).toBe(scoreCandidate({ name: 'Sales Pipeline' }, 'sales', NAME_ONLY))
        })
    })
})
