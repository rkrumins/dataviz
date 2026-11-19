/**
 * The digest harness's server: the routes the chip, the sheet and the watch toggles read and write
 * (`…/resolve`, `…/graphs/{id}/digest`, `…/digest/seen`, `…/watch`), answered from the digest
 * fixtures by scenario. Marking seen and watching change what the next read answers, as the API
 * does.
 *
 *   ok         three new versions since the last visit, a review waiting, two watched entities
 *   week       no marker yet: the last 7 days
 *   truncated  50 of 214 versions since the last visit
 *   cut        the 7-day window cut short (50+)
 *   empty      nothing new since the last visit
 *   loading    the digest never answers
 *   error      the digest fails
 */
import type { GraphDigest, GraphWatching } from '../services/versioningApiService'
import { NOTHING_NEW, digest, truncated, watching } from '../features/versioning/components/__fixtures__/digest'

export type Scenario = 'ok' | 'week' | 'truncated' | 'cut' | 'empty' | 'loading' | 'error'

export const WS = 'ws1'
export const DS = 'ds_sales'
export const GRAPH = 'g1'
export const VIEW = 'view_sales'
export const ENTITY_URN = 'urn:li:dataset:orders'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function first(scenario: Scenario): GraphDigest {
  switch (scenario) {
    case 'week': return digest({ since: null, window: 'last_7_days' })
    case 'truncated': return truncated(214)
    case 'cut': return truncated(null)
    case 'empty': return NOTHING_NEW
    default: return digest()
  }
}

export function digestFetch(scenario: Scenario): typeof fetch {
  let current = first(scenario)
  let watched: GraphWatching = watching({ entities: [{ urn: ENTITY_URN, since: '2026-11-12T09:30:00+00:00' }] })
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin)
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.pathname
    if (path.endsWith('/versioning/resolve')) {
      return json({ graphId: GRAPH, mainBranchId: 'br_main', mainHeadCommitSeq: current.head.seq, kind: 'manual' })
    }
    if (path.endsWith(`/graphs/${GRAPH}/digest`)) {
      if (scenario === 'loading') return new Promise<Response>(() => {})
      if (scenario === 'error') return json({ detail: 'The version store is busy: try again in a moment.' }, 503)
      return json(current)
    }
    if (path.endsWith(`/graphs/${GRAPH}/digest/seen`) && method === 'POST') {
      const { seq } = JSON.parse(String(init?.body ?? '{}')) as { seq: number }
      const at = new Date().toISOString()
      current = { ...NOTHING_NEW, since: { seq, at }, head: current.head, reviewsWaiting: current.reviewsWaiting }
      return json({ seq, at })
    }
    if (path.endsWith(`/graphs/${GRAPH}/watch`)) {
      if (method === 'PUT') {
        const urn = (JSON.parse(String(init?.body ?? '{}')) as { entityUrn?: string }).entityUrn
        watched = urn
          ? { ...watched, entities: [...watched.entities.filter((e) => e.urn !== urn), { urn, since: new Date().toISOString() }] }
          : { ...watched, graph: true }
      } else if (method === 'DELETE') {
        const urn = url.searchParams.get('entityUrn')
        watched = urn ? { ...watched, entities: watched.entities.filter((e) => e.urn !== urn) } : { ...watched, graph: false }
      }
      return json(watched)
    }
    return json({ detail: 'not in the harness' }, 404)
  }
}
