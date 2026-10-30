/**
 * Public and private drafts, as the client calls them: the level a draft opens at and changes to,
 * what a change of level would do first, handing a draft on, the drafts whose owner left, the
 * drafts and reviews policy, who else is saving into a draft, and what a reader may do with a
 * review. The refusals a client acts on arrive as typed errors.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))

import { fetchWithTimeout } from '../fetchWithTimeout'
import {
  getBranch, getBranchFreshness, getDataSourceDraftsPolicy, getDraftLevelImpact,
  getWorkspaceDraftsPolicy, listBranches, listDraftsWhoseOwnerLeft, listReviewerCandidates, openDraft,
  publishBranch, putDataSourceDraftsPolicy, putWorkspaceDraftsPolicy, ReviewRequiredError, setDraftLevel,
  StagedChangesUnsavedError, transferDraft,
} from '../versioningApiService'

const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.mocked(fetchWithTimeout).mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } }))

const call = () => vi.mocked(fetchWithTimeout).mock.calls[0] as [string, RequestInit | undefined]
const sent = () => JSON.parse(String(call()[1]?.body))
const V = '/api/v1/ws1/versioning'
const B = `${V}/graphs/g1/branches`

beforeEach(() => vi.mocked(fetchWithTimeout).mockReset())

describe('a draft’s level', () => {
  it('is asked for when it opens', async () => {
    answer(201, { branchId: 'br_1' })
    await openDraft('ws1', 'g1', { visibility: 'private' })
    expect(call()[0]).toBe(B)
    expect(sent()).toEqual({ visibility: 'private' })
  })

  it('narrows the list: whose drafts, and at which level', async () => {
    answer(200, [])
    await listBranches('ws1', 'g1', { scope: 'public', visibility: 'public' })
    const url = new URL(call()[0], 'http://x')
    expect(url.searchParams.get('scope')).toBe('public')
    expect(url.searchParams.get('visibility')).toBe('public')
  })

  it('changes with a POST, and says beforehand whose edits will be saved', async () => {
    answer(200, { branchId: 'br_1', kind: 'draft', status: 'open', visibility: 'private',
                  createdAt: 't', updatedAt: 't' })
    expect((await setDraftLevel('ws1', 'g1', 'br_1', 'private')).visibility).toBe('private')
    expect(call()[0]).toBe(`${B}/br_1/visibility`)
    expect(call()[1]?.method).toBe('POST')
    expect(sent()).toEqual({ visibility: 'private' })

    vi.mocked(fetchWithTimeout).mockReset()
    answer(200, { visibility: 'private', saved: [{ actor: 'bob', changes: 2 }] })
    const impact = await getDraftLevelImpact('ws1', 'g1', 'br_1', 'private')
    expect(call()[0]).toBe(`${B}/br_1/visibility-impact?visibility=private`)
    expect(impact.saved).toEqual([{ actor: 'bob', changes: 2 }])
  })

  it('stays as it was when someone’s edits could not be saved first, naming whose', async () => {
    answer(409, { detail: { type: 'staged_changes_unsaved', actors: ['carol'], message: 'Unsaved edits of carol…' } })
    const err = await setDraftLevel('ws1', 'g1', 'br_1', 'private').catch((e) => e)
    expect(err).toBeInstanceOf(StagedChangesUnsavedError)
    expect(err.actors).toEqual(['carol'])
  })
})

describe('a draft’s people', () => {
  it('reads one draft with who committed to it', async () => {
    answer(200, { branchId: 'br_1', kind: 'draft', status: 'open', createdAt: 't', updatedAt: 't',
                  contributors: ['bob', 'alice'], access: { canRead: true, canWrite: true, canManage: false } })
    const b = await getBranch('ws1', 'g1', 'br_1')
    expect(call()[0]).toBe(`${B}/br_1`)
    expect(b.contributors).toEqual(['bob', 'alice'])
    expect(b.access?.canWrite).toBe(true)
  })

  it('polls for what others saved since the head it last saw', async () => {
    answer(200, { behind: false, behindBy: 0, mainHeadCommitSeq: 3, baseCommitSeq: 3, status: 'open',
                  headCommitSeq: 7, visibility: 'public', savedSince: { commits: 2, changes: 5, by: ['bob'], capped: false },
                  userNames: { bob: 'Bob B' } })
    const f = await getBranchFreshness('ws1', 'g1', 'br_1', 5)
    expect(call()[0]).toBe(`${B}/br_1/freshness?sinceSeq=5`)
    expect(f.savedSince?.by).toEqual(['bob'])
    expect(f.headCommitSeq).toBe(7)
  })

  it('hands a draft on, keeping the previous owner unless told not to', async () => {
    answer(200, { branchId: 'br_1', kind: 'draft', status: 'open', owner: 'bob', createdAt: 't', updatedAt: 't' })
    await transferDraft('ws1', 'g1', 'br_1', { to: 'bob', keepPrevious: false })
    expect(call()[0]).toBe(`${B}/br_1/transfer`)
    expect(sent()).toEqual({ to: 'bob', keepPrevious: false })
  })

  it('lists the drafts whose owner left, for an admin', async () => {
    answer(200, [{ graphId: 'g1', branchId: 'br_1', owner: 'carol', visibility: 'private', status: 'open',
                   updatedAt: 't', userNames: {} }])
    const rows = await listDraftsWhoseOwnerLeft('ws1')
    expect(call()[0]).toBe(`${V}/drafts/owner-left`)
    expect(rows[0].owner).toBe('carol')
  })
})

describe('the drafts and reviews policy', () => {
  it('is read and set for the workspace', async () => {
    answer(200, { settings: {}, effective: { defaultVisibility: 'public', levels: 'any', selfApproval: true,
                                             selfMerge: true, sources: {} } })
    await getWorkspaceDraftsPolicy('ws1')
    expect(call()[0]).toBe(`${V}/drafts-policy`)

    vi.mocked(fetchWithTimeout).mockReset()
    answer(200, { settings: { selfMerge: false }, effective: {} })
    await putWorkspaceDraftsPolicy('ws1', { selfMerge: false, levels: 'inherit' })
    expect(call()[1]?.method).toBe('PUT')
    expect(sent()).toEqual({ selfMerge: false, levels: 'inherit' })
  })

  it('is read and overridden for a data source', async () => {
    answer(200, { overrides: {}, workspace: {}, effective: {} })
    await getDataSourceDraftsPolicy('ws1', 'ds 1')
    expect(call()[0]).toBe(`${V}/data-sources/ds%201/drafts-policy`)

    vi.mocked(fetchWithTimeout).mockReset()
    answer(200, { overrides: { levels: 'private_only' }, workspace: {}, effective: {} })
    await putDataSourceDraftsPolicy('ws1', 'ds1', { levels: 'private_only' })
    expect(call()[0]).toBe(`${V}/data-sources/ds1/drafts-policy`)
    expect(call()[1]?.method).toBe('PUT')
  })

  it('asks for a review where nobody publishes their own changes', async () => {
    answer(409, { detail: { type: 'review_required', branchId: 'br_1', message: 'open a review instead' } })
    const err = await publishBranch('ws1', 'g1', 'br_1', { message: 'm' }).catch((e) => e)
    expect(err).toBeInstanceOf(ReviewRequiredError)
    expect(err.branchId).toBe('br_1')
  })

  it('lists the reviewers who could approve a data source’s reviews', async () => {
    answer(200, [])
    await listReviewerCandidates('ws1', 'ds1')
    expect(call()[0]).toBe(`${V}/reviewers?dataSourceId=ds1`)
  })
})
