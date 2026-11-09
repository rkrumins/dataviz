/**
 * A past revision of Published rides on every graph read (`?asOfSeq=`), so the server answers
 * each read as the graph was then or refuses it — never the graph as it is now. Only the data
 * source's own chrome (its statistics, schema and ontology, whether it answers at all) goes
 * without, as it is now. A revision is a read context of its own: its own provider, response
 * cache and scope, apart from Published and from every other revision.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}))

import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { REVISION_TOO_FAR_EVENT, RemoteGraphProvider, readsAsItIsNow } from '../RemoteGraphProvider'
import { getOrCreateProvider, poolKey } from '../providerPool'

const mockFetch = vi.mocked(fetchWithTimeout)

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

const urls = () => mockFetch.mock.calls.map((c) => String(c[0]))

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockResolvedValue(okJson({ data: {}, meta: null }))
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('RemoteGraphProvider at a past revision', () => {
  const atRevision = () => new RemoteGraphProvider({ workspaceId: 'ws_1', dataSourceId: 'ds_1', asOfSeq: 12 })

  it('names the revision on the reads of the graph', async () => {
    const p = atRevision()
    await p.getTopLevelNodes({ limit: 5 } as never).catch(() => {})
    await p.getNode('urn:a').catch(() => {})
    for (const url of urls()) expect(url).toContain('asOfSeq=12')
  })

  it('reads the data source itself as it is now', async () => {
    const p = atRevision()
    await p.getStats().catch(() => {})
    expect(urls().at(-1)).not.toContain('asOfSeq=')
    for (const path of ['/stats', '/introspection', '/metadata/ontology', '/metadata/schema']) {
      expect(readsAsItIsNow(path)).toBe(true)
    }
    // Everything else names the revision, and the server answers it as it was or refuses it.
    for (const path of ['/nodes/top-level', '/search', '/trace/v2', '/metadata/entity-types', '/stats/extra']) {
      expect(readsAsItIsNow(path)).toBe(false)
    }
  })

  it('names none on Published', async () => {
    await new RemoteGraphProvider({ workspaceId: 'ws_1', dataSourceId: 'ds_1' }).getNode('urn:a').catch(() => {})
    expect(urls().at(-1)).not.toContain('asOfSeq=')
  })

  it('is a scope of its own: two revisions, and the graph as it is, never share a cache', () => {
    const now = new RemoteGraphProvider({ workspaceId: 'w', dataSourceId: 'd' })
    const r12 = new RemoteGraphProvider({ workspaceId: 'w', dataSourceId: 'd', asOfSeq: 12 })
    const r13 = new RemoteGraphProvider({ workspaceId: 'w', dataSourceId: 'd', asOfSeq: 13 })
    expect(new Set([now.scopeKey, r12.scopeKey, r13.scopeKey]).size).toBe(3)
    expect(new Set([poolKey('w', 'd'), poolKey('w', 'd', null, null, 12), poolKey('w', 'd', null, null, 13)]).size).toBe(3)
    expect(getOrCreateProvider('w', 'd', null, 'v', 12)).not.toBe(getOrCreateProvider('w', 'd', null, 'v'))
  })

  it('says when the server finds Published has moved too far on from the revision to draw it', async () => {
    const heard: unknown[] = []
    const listen = (e: Event) => heard.push((e as CustomEvent).detail)
    const refuse = (detail: unknown) => mockFetch.mockImplementation(async () =>
      new Response(JSON.stringify({ detail }), { status: 409 }))
    window.addEventListener(REVISION_TOO_FAR_EVENT, listen)
    try {
      refuse({ type: 'revision_too_far', asOfSeq: 12, headSeq: 90, changed: 100_001, limit: 100_000 })
      const err = await atRevision().getNode('urn:a').catch((e) => e)
      expect(err).toMatchObject({ status: 409, code: 'revision_too_far' })
      expect(heard).toEqual([{ asOfSeq: 12 }])

      // No other refusal is that, and Published is never at a revision.
      refuse({ type: 'state_too_large', entities: 9, limit: 5 })
      await atRevision().getNode('urn:b').catch(() => {})
      refuse({ type: 'revision_too_far', asOfSeq: 12, headSeq: 90, changed: 100_001, limit: 100_000 })
      await new RemoteGraphProvider({ workspaceId: 'ws_1', dataSourceId: 'ds_1' }).getNode('urn:c').catch(() => {})
      expect(heard).toHaveLength(1)
    } finally {
      window.removeEventListener(REVISION_TOO_FAR_EVENT, listen)
    }
  })

  it('never reads a draft at a revision', async () => {
    const p = getOrCreateProvider('w2', 'd2', 'br_1', null, 12)
    await p.getNode('urn:a').catch(() => {})
    expect(urls().at(-1)).toContain('branchId=br_1')
    expect(urls().at(-1)).not.toContain('asOfSeq=')
  })
})
