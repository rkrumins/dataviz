import { describe, expect, it, vi } from 'vitest'

import type { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { MemberSetRequest, MemberSetStatus } from '@/types/memberSet'

import { followMemberSet } from '../memberSetExport'

function answer(over: Partial<MemberSetStatus>): MemberSetStatus {
    return {
        setId: 'ms_1', specHash: 'h', status: 'running', stage: 'upstream',
        counts: { seeds: 2, inside: 0, upstream: 0, downstream: 0, partnerInside: 0, total: 2 },
        missingSeeds: 0, truncated: [], dataVersion: '1', progress: { steps: 1, queued: 3 },
        startedAt: '', expiresAt: '', ...over,
    }
}

function providerAnswering(...answers: MemberSetStatus[]) {
    const memberSet = vi.fn(async (_v: string | null, _b: MemberSetRequest, _o?: { signal?: AbortSignal }) => {
        const next = answers.shift()
        if (!next) throw new Error('no more answers')
        return next
    })
    return { provider: { memberSet } as unknown as RemoteGraphProvider, memberSet }
}

const REQUEST = {
    spec: { v: 1 as const, seeds: { urns: ['a', 'b'] }, within: 'view' as const,
        expand: { children: 0, upstream: 'all' as const, downstream: 'all' as const, partnerChildren: 0 } },
    includeEdges: true,
}

describe('followMemberSet', () => {
    it('sends the set back until it is complete, reporting each answer', async () => {
        const { provider, memberSet } = providerAnswering(
            answer({ setId: 'ms_1' }),
            answer({ setId: 'ms_1', stage: 'downstream' }),
            answer({ setId: 'ms_1', status: 'complete', stage: 'done', downloadToken: 't' }),
        )
        const stages: string[] = []
        const final = await followMemberSet(provider, 'view-1', REQUEST, { onUpdate: (a) => stages.push(a.stage) })
        expect(final.downloadToken).toBe('t')
        expect(stages).toEqual(['upstream', 'downstream', 'done'])
        const calls = memberSet.mock.calls
        expect(calls[0]![0]).toBe('view-1')
        expect(calls[0]![1]).toEqual({ ...REQUEST, waitMs: 10000 })
        expect(calls[1]![1]).toEqual({ ...REQUEST, waitMs: 10000, setId: 'ms_1' })
    })

    it('a set the server could not work out is a failure, not a wait forever', async () => {
        const { provider } = providerAnswering(answer({ status: 'failed' }))
        await expect(followMemberSet(provider, null, REQUEST)).rejects.toThrow(/could not work this out/)
    })

    it('rejects when a request fails', async () => {
        const memberSet = vi.fn(async () => { throw new Error('Service Unavailable') })
        await expect(followMemberSet({ memberSet } as unknown as RemoteGraphProvider, null, REQUEST))
            .rejects.toThrow('Service Unavailable')
    })
})
