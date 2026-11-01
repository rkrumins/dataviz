/**
 * A graph's forks: listed, moved to the trash and restored through the fork routes, and a refusal
 * arrives as a ForkRefusedError that says, in words, what to do instead of the server's message.
 * A fork is made with a name, takes its parent's changes with Update from parent — at once, or by
 * a job it follows to its end — and proposes its changes back as a review. What both changed
 * arrives as a ForkUpdateConflictsError with the fork's own values to resolve from, and a review
 * of a fork behind its parent as a ForkNotUpToDateError, never as a draft's NotUpToDateError.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))
// A job is followed like every job (pollJob); its waits shortened so the tests don't sit them out.
vi.mock('@/config/polling', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/config/polling')>(),
  jobPollDelayMs: () => 1,
}))

import { fetchWithTimeout } from '../fetchWithTimeout'
import {
  createFork, deleteFork, ForkNotUpToDateError, ForkRefusedError, ForkUpdateConflictsError, GraphNotWritableError,
  listForks, mergeMergeRequest, NotUpToDateError, openForkPullRequest, restoreFork, updateFromParent,
} from '../versioningApiService'

const answer = (status: number, body?: unknown) =>
  vi.mocked(fetchWithTimeout).mockResolvedValue(
    body === undefined
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

const call = () => vi.mocked(fetchWithTimeout).mock.calls[0] as [string, RequestInit | undefined]

beforeEach(() => vi.mocked(fetchWithTimeout).mockReset())

describe('the fork routes', () => {
  it("lists a graph's forks", async () => {
    answer(200, [{ graphId: 'f1', deletedAt: null, purging: false }])
    expect(await listForks('ws1', 'g1')).toEqual([{ graphId: 'f1', deletedAt: null, purging: false }])
    expect(call()[0]).toBe('/api/v1/ws1/versioning/graphs/g1/forks')
  })

  it('deletes a fork with DELETE and restores it with POST …/restore', async () => {
    answer(204)
    await expect(deleteFork('ws1', 'f1')).resolves.toBeUndefined()
    expect(call()[0]).toBe('/api/v1/ws1/versioning/graphs/f1')
    expect(call()[1]?.method).toBe('DELETE')
    vi.mocked(fetchWithTimeout).mockClear()
    answer(204)
    await expect(restoreFork('ws1', 'f1')).resolves.toBeUndefined()
    expect(call()[0]).toBe('/api/v1/ws1/versioning/graphs/f1/restore')
    expect(call()[1]?.method).toBe('POST')
  })
})

describe('a fork refusal', () => {
  it.each([
    [{ type: 'live_forks', graphId: 'f1', forks: 2 }, 'Delete its forks first'],
    [{ type: 'not_a_fork', graphId: 'f1' }, 'goes with its data source'],
    [{ type: 'fork_not_restorable', graphId: 'f1', reason: 'purging' }, 'being deleted'],
    [{ type: 'fork_not_restorable', graphId: 'f1', reason: 'parent_deleted' }, 'Restore that first'],
    [{ type: 'fork_limit', limit: 10 }, 'already has 10 forks'],
  ])('%o reads in words', async (detail, words) => {
    answer(409, { detail: { ...detail, message: 'server words' } })
    const err = await restoreFork('ws1', 'f1').catch((e) => e)
    expect(err).toBeInstanceOf(ForkRefusedError)
    expect(err.type).toBe(detail.type)
    expect(err.message).toContain(words)
  })
})

/** Answers each call in turn: a status and a JSON body. */
const answers = (...replies: Array<[number, unknown]>) => {
  for (const [status, body] of replies) {
    vi.mocked(fetchWithTimeout).mockResolvedValueOnce(
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
  }
}
const calls = () => vi.mocked(fetchWithTimeout).mock.calls.map(
  (c) => `${(c[1] as RequestInit | undefined)?.method ?? 'GET'} ${String(c[0])}`)
const bodyOf = (i: number) => JSON.parse(String((vi.mocked(fetchWithTimeout).mock.calls[i][1] as RequestInit).body))

describe('making a fork', () => {
  it('posts its name, trimmed, and answers with its graph and data source', async () => {
    answer(201, { graphId: 'g_f', dataSourceId: 'dsfork_1', mainBranchId: 'b_f', forkBaseCommitSeq: 7 })
    expect(await createFork('ws1', 'g1', { name: '  Q3 restructure ' })).toEqual(
      { graphId: 'g_f', dataSourceId: 'dsfork_1', mainBranchId: 'b_f', forkBaseCommitSeq: 7 })
    expect(calls()).toEqual(['POST /api/v1/ws1/versioning/graphs/g1/forks'])
    expect(bodyOf(0)).toEqual({ name: 'Q3 restructure' })
  })

  it('sends no name when none is given, so the server names it', async () => {
    answer(201, { graphId: 'g_f', dataSourceId: 'dsfork_1', mainBranchId: 'b_f', forkBaseCommitSeq: 7 })
    await createFork('ws1', 'g1', { name: '   ' })
    expect(bodyOf(0)).toEqual({})
  })

  it('says why it was refused: the fork cap, paused editing, forks turned off', async () => {
    answer(409, { detail: { type: 'fork_limit', limit: 10, message: 'server words' } })
    const cap = await createFork('ws1', 'g1').catch((e) => e)
    expect(cap).toBeInstanceOf(ForkRefusedError)
    expect(cap.message).toContain('already has 10 forks')

    answer(409, { detail: { type: 'graph_not_writable', state: 'frozen', message: 'Editing is paused on this graph.' } })
    const paused = await createFork('ws1', 'g1').catch((e) => e)
    expect(paused).toBeInstanceOf(GraphNotWritableError)
    expect(paused.message).toBe('Editing is paused on this graph.')

    answer(403, { detail: { type: 'feature_disabled', feature: 'forksEnabled', message: 'Forks are turned off for this deployment.' } })
    const off = await createFork('ws1', 'g1').catch((e) => e)
    expect(off.message).toBe('Forks are turned off for this deployment.')
  })
})

describe('Update from parent', () => {
  const UPDATE = 'POST /api/v1/ws1/versioning/graphs/g_f/update-from-parent'
  const JOB = 'GET /api/v1/ws1/versioning/graphs/g_f/update-jobs/vjob_1'
  const conflicts = [{ entity_id: 'n1', path: ['displayName'], base: 'A', ours: 'B', theirs: 'C' }]

  it('answers what the update did when it runs inside the request', async () => {
    answer(200, { commitId: 'c9', parentSeq: 12, wrote: 3, upToDate: false })
    expect(await updateFromParent('ws1', 'g_f')).toEqual({ commitId: 'c9', parentSeq: 12, wrote: 3, upToDate: false })
    expect(calls()).toEqual([UPDATE])
    expect(bodyOf(0)).toEqual({})
  })

  it('follows a large update’s job to what it did', async () => {
    answers(
      [202, { jobId: 'vjob_1', graphId: 'g_f', status: 'pending' }],
      [200, { jobId: 'vjob_1', graphId: 'g_f', status: 'running', commitId: null, error: null }],
      [200, { jobId: 'vjob_1', graphId: 'g_f', status: 'completed', commitId: 'c9', parentSeq: 12, wrote: 25000, upToDate: false, error: null }],
    )
    expect(await updateFromParent('ws1', 'g_f')).toEqual({ commitId: 'c9', parentSeq: 12, wrote: 25000, upToDate: false })
    expect(calls()).toEqual([UPDATE, JOB, JOB])
  })

  it('raises what both changed, with the fork’s own values, and sends resolutions back', async () => {
    answer(409, { detail: { type: 'fork_update_conflicts', conflicts, seeds: { n1: { displayName: 'B' } }, message: 'm' } })
    const err = await updateFromParent('ws1', 'g_f').catch((e) => e)
    expect(err).toBeInstanceOf(ForkUpdateConflictsError)
    expect(err.conflicts).toEqual(conflicts)
    expect(err.seeds).toEqual({ n1: { displayName: 'B' } })

    vi.mocked(fetchWithTimeout).mockClear()
    answer(200, { commitId: 'c10', parentSeq: 12, wrote: 1, upToDate: false })
    await updateFromParent('ws1', 'g_f', { resolutions: { n1: { displayName: 'C' } } })
    expect(bodyOf(0)).toEqual({ resolutions: { n1: { displayName: 'C' } } })
  })

  it('raises a job’s conflicts as the request would have, with how many there were', async () => {
    answers(
      [202, { jobId: 'vjob_1', graphId: 'g_f', status: 'pending' }],
      [200, { jobId: 'vjob_1', graphId: 'g_f', status: 'failed', commitId: null, error: {
        status: 409, detail: { type: 'fork_update_conflicts', conflicts, seeds: { n1: null }, total: 140, message: 'm' },
      } }],
    )
    const err = await updateFromParent('ws1', 'g_f').catch((e) => e)
    expect(err).toBeInstanceOf(ForkUpdateConflictsError)
    expect(err.total).toBe(140)
    expect(err.seeds).toEqual({ n1: null })
  })
})

describe('the review into the parent', () => {
  it('opens a fork’s review on the fork', async () => {
    answer(201, { prId: 'pr_9' })
    expect(await openForkPullRequest('ws1', 'g_f', { title: 'Q3', reviewers: ['u2'] })).toEqual({ prId: 'pr_9' })
    expect(calls()).toEqual(['POST /api/v1/ws1/versioning/graphs/g_f/pulls'])
    expect(bodyOf(0)).toEqual({ title: 'Q3', reviewers: ['u2'] })
  })

  it('says a fork behind its parent updates first — not that a draft pulls', async () => {
    answer(409, { detail: { type: 'not_up_to_date', reason: 'parent_moved', behind: 4, graphId: 'g_f', message: 'update from parent first.' } })
    const err = await mergeMergeRequest('ws1', 'pr_9', { message: 'm' }).catch((e) => e)
    expect(err).toBeInstanceOf(ForkNotUpToDateError)
    expect(err).not.toBeInstanceOf(NotUpToDateError)
    expect(err.behind).toBe(4)
    expect(err.graphId).toBe('g_f')
  })

  it('still raises a draft behind main as NotUpToDateError', async () => {
    answer(409, { detail: { type: 'not_up_to_date', branchId: 'b1', behindBy: 2, message: 'behind' } })
    await expect(mergeMergeRequest('ws1', 'pr_1', { message: 'm' })).rejects.toBeInstanceOf(NotUpToDateError)
  })
})
