import { describe, expect, it, vi } from 'vitest'

import type { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { Predicate, SearchCountsRequest, SearchCountsResult } from '@/types/search'

import { countRules, type RuleCount } from '../ruleCounts'


const leaf: Predicate = { kind: 'tag', op: 'hasAny', values: ['PII'] }
const group: Predicate = { kind: 'group', op: 'and', children: [leaf] }

function providerAnswering(...answers: SearchCountsResult[]) {
    const searchCounts = vi.fn(async (_body: SearchCountsRequest) => {
        const next = answers.shift()
        if (!next) throw new Error('no more answers')
        return next
    })
    return { provider: { searchCounts } as unknown as RemoteGraphProvider, searchCounts }
}


describe('countRules', () => {
    it('sends the returned sessions back until every count is complete', async () => {
        const { provider, searchCounts } = providerAnswering(
            { counts: {
                a: { count: 10, status: 'running', sessionId: 's-a', progress: { scanned: 30, total: 100, matched: 10 } },
                b: { count: 2, status: 'complete' },
            } },
            { counts: {
                a: { count: 25, status: 'complete', sessionId: 's-a' },
                b: { count: 2, status: 'complete' },
            } },
        )
        const updates: ReadonlyMap<string, RuleCount>[] = []
        const final = await countRules(provider, 'view-1', [
            { id: 'a', predicate: group }, { id: 'b', predicate: group },
        ], { onUpdate: (c) => updates.push(c) })

        expect(searchCounts).toHaveBeenCalledTimes(2)
        const [first, second] = searchCounts.mock.calls.map(([body]) => body)
        expect(first.scope).toEqual({ viewId: 'view-1', scopeMode: 'view' })
        expect(first.sessions).toEqual({})
        expect(second.sessions).toEqual({ a: 's-a' })

        expect(updates).toHaveLength(2)
        expect(updates[0].get('a')).toEqual({ count: 10, complete: false, percent: 30 })
        expect(updates[0].get('b')).toEqual({ count: 2, complete: true, percent: 100 })
        expect(final.get('a')).toEqual({ count: 25, complete: true, percent: 100 })
    })

    it('never reads 100% before the count is complete', async () => {
        const { provider } = providerAnswering(
            { counts: { a: { count: 5, status: 'running', sessionId: 's', progress: { scanned: 100, total: 100, matched: 5 } } } },
            { counts: { a: { count: 5, status: 'complete' } } },
        )
        const updates: ReadonlyMap<string, RuleCount>[] = []
        await countRules(provider, 'v', [{ id: 'a', predicate: group }], {
            onUpdate: (c) => updates.push(c),
        })
        expect(updates[0].get('a')?.percent).toBe(99)
        expect(updates[1].get('a')?.percent).toBe(100)
    })

    it('asks about at most 32 rules a request', async () => {
        const rules = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, predicate: group }))
        const complete = (ids: string[]): SearchCountsResult => ({
            counts: Object.fromEntries(ids.map((id) => [id, { count: 1, status: 'complete' as const }])),
        })
        const { provider, searchCounts } = providerAnswering(
            complete(rules.slice(0, 32).map((r) => r.id)),
            complete(rules.slice(32).map((r) => r.id)),
        )
        const final = await countRules(provider, 'v', rules)
        expect(searchCounts.mock.calls.map(([body]) => body.items.length)).toEqual([32, 8])
        expect(final.size).toBe(40)
    })

    it('AND-wraps a bare leaf, as every search does', async () => {
        const { provider, searchCounts } = providerAnswering(
            { counts: { a: { count: 0, status: 'complete' } } },
        )
        await countRules(provider, 'v', [{ id: 'a', predicate: leaf }])
        expect(searchCounts.mock.calls[0][0].items).toEqual([{ id: 'a', predicate: group }])
    })

    it("carries a rule's error", async () => {
        const { provider } = providerAnswering(
            { counts: { a: { count: 0, status: 'complete', error: 'Unknown operator' } } },
        )
        const final = await countRules(provider, 'v', [{ id: 'a', predicate: group }])
        expect(final.get('a')).toEqual({ count: 0, complete: true, percent: 100, error: 'Unknown operator' })
    })

    it('when a request fails, says where each unfinished count stopped, then rejects', async () => {
        const searchCounts = vi.fn()
            .mockResolvedValueOnce({ counts: {
                a: { count: 12, status: 'running', sessionId: 's', progress: { scanned: 40, total: 100, matched: 12 } },
                b: { count: 3, status: 'complete' },
            } })
            .mockRejectedValueOnce(new Error('Service Unavailable'))
        const provider = { searchCounts } as unknown as RemoteGraphProvider
        const updates: ReadonlyMap<string, RuleCount>[] = []
        await expect(countRules(provider, 'v', [
            { id: 'a', predicate: group }, { id: 'b', predicate: group }, { id: 'never', predicate: group },
        ], { onUpdate: (c) => updates.push(c) })).rejects.toThrow('Service Unavailable')

        const last = updates[updates.length - 1]
        const error = 'The count stopped: Service Unavailable'
        expect(last.get('a')).toEqual({ count: 12, complete: false, percent: 40, error })
        expect(last.get('b')).toEqual({ count: 3, complete: true, percent: 100 })
        expect(last.get('never')).toEqual({ count: 0, complete: false, percent: 0, error })
    })

    it('an aborted count rejects without reporting anything more', async () => {
        const controller = new AbortController()
        const searchCounts = vi.fn(async () => {
            controller.abort()
            throw new DOMException('aborted', 'AbortError')
        })
        const provider = { searchCounts } as unknown as RemoteGraphProvider
        const onUpdate = vi.fn()
        await expect(countRules(provider, 'v', [{ id: 'a', predicate: group }], {
            signal: controller.signal, onUpdate,
        })).rejects.toThrow('aborted')
        expect(onUpdate).not.toHaveBeenCalled()
    })

    it('stops a count that never finishes, and says so', async () => {
        const searchCounts = vi.fn(async () => ({
            counts: { a: { count: 1, status: 'running' as const, sessionId: 's' } },
        }))
        const provider = { searchCounts } as unknown as RemoteGraphProvider
        const updates: ReadonlyMap<string, RuleCount>[] = []
        await expect(countRules(provider, 'v', [{ id: 'a', predicate: group }], {
            onUpdate: (c) => updates.push(c),
        })).rejects.toThrow('still counting after 600 requests')
        expect(searchCounts).toHaveBeenCalledTimes(600)
        expect(updates[updates.length - 1].get('a')?.error).toMatch(/^The count stopped/)
    })
})
