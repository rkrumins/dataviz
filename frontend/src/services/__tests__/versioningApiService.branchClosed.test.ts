/**
 * A save the server refuses because its draft has closed (published, being published, discarded),
 * or because it named Published itself, must arrive as a typed error — the canvas keeps the staged
 * edits and offers to copy them to a new draft only for the first.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))

import { fetchWithTimeout } from '../fetchWithTimeout'
import { applyGraphChanges, BranchClosedError, MainWriteForbiddenError } from '../versioningApiService'

const answer = (status: number, body: unknown) =>
  vi.mocked(fetchWithTimeout).mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

const save = () => applyGraphChanges('ws1', 'ds1', 'br_1', []).catch((e) => e)

beforeEach(() => vi.mocked(fetchWithTimeout).mockReset())

describe('a save to a closed draft', () => {
  it.each([
    ['merged', 'This draft has been published'],
    ['publishing', 'This draft is being published'],
    ['abandoned', 'This draft was discarded'],
  ])('names a %s draft, in words rather than the server message', async (status, words) => {
    answer(409, { detail: { type: 'branch_closed', status, branchId: 'br_1', message: `branch br_1 is ${status}` } })
    const err = await save()
    expect(err).toBeInstanceOf(BranchClosedError)
    expect(err.status).toBe(status)
    expect(err.branchId).toBe('br_1')
    expect(err.message).toContain(words)
  })
})

describe('a save to Published', () => {
  it('is refused with its own error', async () => {
    answer(409, { detail: { type: 'main_write_forbidden', message: 'edits go to a draft' } })
    const err = await save()
    expect(err).toBeInstanceOf(MainWriteForbiddenError)
    expect(err.message).toContain('open a draft')
  })
})
