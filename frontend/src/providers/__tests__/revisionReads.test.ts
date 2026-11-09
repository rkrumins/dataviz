/**
 * What a past revision reads, held to the server's list, and search there as a name search.
 *
 * The client's list of the reads a revision answers is the server's revision gate's: both are the
 * fixture `backend/tests/fixtures/revision_reads.txt`. At a revision the provider refuses every
 * other read before sending it, as the server would, and Advanced Search becomes a name search on
 * `/search/names`, answered as a finished page of hits.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}))

import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import type { SearchQuery } from '@/types/search'
import { RemoteGraphProvider } from '../RemoteGraphProvider'
import {
  REVISION_READS, nameSearchOf, readsAtRevision, toSearchResultPage,
} from '../revisionReads'

const mockFetch = vi.mocked(fetchWithTimeout)

function okJson(body: unknown): Response {
  return {
    ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response
}

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockResolvedValue(okJson({ hits: [], hasMore: false, nextOffset: 0 }))
})

afterEach(() => {
  vi.clearAllMocks()
})

const text = (value: string, extra: Record<string, unknown> = {}): SearchQuery => ({
  predicate: { kind: 'text', target: 'name', value, match: 'prefix', ...extra },
  scope: { viewId: 'v1' },
  options: { results: 'both', pageSize: 1000 },
} as unknown as SearchQuery)

describe('the reads a revision answers', () => {
  it('are the server gate’s, line for line', () => {
    const fixture = resolve(__dirname, '../../../../backend/tests/fixtures/revision_reads.txt')
    const listed = readFileSync(fixture, 'utf-8').split('\n')
      .map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
    expect([...REVISION_READS].sort()).toEqual(listed.sort())
  })

  it('match by method and path, a parameter one segment', () => {
    expect(readsAtRevision('get', '/nodes/urn%3Ali%3Ax/children?limit=5')).toBe(true)
    expect(readsAtRevision('POST', '/trace/closure')).toBe(true)
    expect(readsAtRevision('POST', '/search/names')).toBe(true)
    for (const [method, path] of [['POST', '/search/advanced'], ['POST', '/trace/v2'],
      ['POST', '/nodes/create'], ['GET', '/nodes/a/parent'], ['GET', '/nodes/by-layer/x'],
      ['POST', '/members'], ['GET', '/metadata/entity-types'], ['GET', '/nodes/top-level/x']]) {
      expect(readsAtRevision(method, path), `${method} ${path}`).toBe(false)
    }
  })
})

describe('search at a revision', () => {
  it('is one text leaf on names, by a match a name search has', () => {
    expect(nameSearchOf(text('Ord'))).toEqual({ q: 'Ord', match: 'prefix', limit: 50, offset: 0 })
    expect(nameSearchOf({ ...text('Ord'), options: { cursor: 'names:50', pageSize: 20 } } as SearchQuery))
      .toEqual({ q: 'Ord', match: 'prefix', limit: 20, offset: 50 })
    expect(nameSearchOf(text('Ord', { target: 'any' }))).toBeNull()             // not names alone
    expect(nameSearchOf(text('Ord', { match: 'regex' }))).toBeNull()
    expect(nameSearchOf(text('Ord', { caseSensitive: true }))).toBeNull()
    expect(nameSearchOf(text('  '))).toBeNull()
    expect(nameSearchOf({ ...text('x'), predicate: { kind: 'and', children: [] } } as unknown as SearchQuery))
      .toBeNull()                                                                 // inside a container, or more
  })

  it('answers a finished page, its next by cursor and its total on the last', () => {
    const more = toSearchResultPage({ hits: [], hasMore: true, nextOffset: 50 }, 0, 12)
    expect([more.cursor, more.totalCount, more.status]).toEqual(['names:50', null, 'complete'])
    const last = toSearchResultPage({ hits: [{} as never, {} as never], hasMore: false, nextOffset: 52 }, 50, 3)
    expect([last.cursor, last.totalCount]).toEqual([null, 52])
  })
})

describe('RemoteGraphProvider at a past revision', () => {
  const atRevision = () => new RemoteGraphProvider({ workspaceId: 'ws_1', dataSourceId: 'ds_1', asOfSeq: 12 })

  it('sends a name search to /search/names, as the graph was', async () => {
    const page = await atRevision().searchAdvanced(text('Ord'))
    const [url, init] = mockFetch.mock.calls[0]
    expect(String(url)).toContain('/search/names?')
    expect(String(url)).toContain('asOfSeq=12')
    expect(JSON.parse(String((init as RequestInit).body))).toEqual(
      { q: 'Ord', match: 'prefix', limit: 50, offset: 0 })
    expect(page.status).toBe('complete')
  })

  it('refuses what reads the graph as it is now, sending nothing', async () => {
    const p = atRevision()
    for (const call of [
      () => p.searchAdvanced(text('Ord', { target: 'any' })),
      () => p.searchMembership({} as never),
      () => p.searchCounts({} as never),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: 501, code: 'revision_unsupported' })
    }
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('searches the graph as it is now, on Published', async () => {
    mockFetch.mockResolvedValue(okJson({ hits: [], truncated: false, candidateCount: 0 }))
    await new RemoteGraphProvider({ workspaceId: 'ws_1', dataSourceId: 'ds_1' }).searchAdvanced(text('Ord'))
    expect(String(mockFetch.mock.calls[0][0])).toContain('/search/advanced')
  })
})
