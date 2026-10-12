/**
 * Publishing a draft too large to publish inside the request: the server answers 202 with a job,
 * and the call follows it to its commit — or raises the error the request would have raised (a
 * draft behind Published → NotUpToDateError), so the publish and review dialogs work unchanged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeMergeRequest, NotUpToDateError, PUBLISH_JOB_POLL, publishBranch } from './versioningApiService'

// The job is followed like every job (pollJob); its waits shortened so the tests don't sit them out.
vi.mock('@/config/polling', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/config/polling')>(),
    jobPollDelayMs: () => 1,
}))

const realFetch = globalThis.fetch

function serve(responses: Array<[number, unknown]>) {
    const f = vi.fn(async (..._args: Parameters<typeof fetch>) => {
        const [status, body] = responses.shift()!
        return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    })
    globalThis.fetch = f as unknown as typeof fetch
    return () => f.mock.calls.map((c) => `${(c[1] as RequestInit | undefined)?.method ?? 'GET'} ${String(c[0])}`)
}

const JOB = '/api/v1/ws1/versioning/graphs/g1/publish-jobs/vjob_1'

describe('publishing a large draft', () => {
    afterEach(() => { globalThis.fetch = realFetch; PUBLISH_JOB_POLL.patienceMs = 120_000 })

    it('publishes a small draft in the request, as before', async () => {
        const calls = serve([[200, { commitId: 'cmt_1' }]])
        await expect(publishBranch('ws1', 'g1', 'br_1', { message: 'm' })).resolves.toEqual({ commitId: 'cmt_1' })
        expect(calls()).toEqual(['POST /api/v1/ws1/versioning/graphs/g1/branches/br_1/publish'])
    })

    it('follows a publish job to its commit', async () => {
        const calls = serve([
            [202, { jobId: 'vjob_1', graphId: 'g1', status: 'pending' }],
            [200, { jobId: 'vjob_1', graphId: 'g1', status: 'running', commitId: null, error: null }],
            [200, { jobId: 'vjob_1', graphId: 'g1', status: 'completed', commitId: 'cmt_2', error: null }],
        ])
        await expect(publishBranch('ws1', 'g1', 'br_1', { message: 'm' })).resolves.toEqual({ commitId: 'cmt_2' })
        expect(calls()).toEqual([
            'POST /api/v1/ws1/versioning/graphs/g1/branches/br_1/publish', `GET ${JOB}`, `GET ${JOB}`,
        ])
    })

    it('raises what the request would have when the job is refused', async () => {
        serve([
            [202, { jobId: 'vjob_1', graphId: 'g1', status: 'pending' }],
            [200, { jobId: 'vjob_1', graphId: 'g1', status: 'failed', commitId: null, error: {
                status: 409, detail: { type: 'not_up_to_date', branchId: 'br_1', behindBy: 2, message: 'behind' },
            } }],
        ])
        await expect(publishBranch('ws1', 'g1', 'br_1', { message: 'm' })).rejects.toBeInstanceOf(NotUpToDateError)
    })

    it('keeps following a job through a failed poll — the job runs on regardless', async () => {
        serve([
            [202, { jobId: 'vjob_1', graphId: 'g1', status: 'pending' }],
            [502, { detail: 'Bad Gateway' }],
            [200, { jobId: 'vjob_1', graphId: 'g1', status: 'completed', commitId: 'cmt_2', error: null }],
        ])
        await expect(publishBranch('ws1', 'g1', 'br_1', { message: 'm' })).resolves.toEqual({ commitId: 'cmt_2' })
    })

    it('gives up once the job has gone unanswered too long', async () => {
        PUBLISH_JOB_POLL.patienceMs = 0
        serve([
            [202, { jobId: 'vjob_1', graphId: 'g1', status: 'pending' }],
            [503, { detail: 'unavailable' }],
        ])
        await expect(publishBranch('ws1', 'g1', 'br_1', { message: 'm' })).rejects.toThrow('unavailable')
    })

    it('follows the merge of a large draft’s review the same way', async () => {
        const calls = serve([
            [202, { jobId: 'vjob_1', graphId: 'g1', status: 'pending' }],
            [200, { jobId: 'vjob_1', graphId: 'g1', status: 'completed', commitId: 'cmt_3', error: null }],
        ])
        await expect(mergeMergeRequest('ws1', 'mr_1', { message: 'ship' })).resolves.toEqual({ commitId: 'cmt_3' })
        expect(calls()).toEqual(['POST /api/v1/ws1/versioning/merge-requests/mr_1/merge', `GET ${JOB}`])
    })
})
