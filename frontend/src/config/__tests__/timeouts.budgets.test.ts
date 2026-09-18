/**
 * Deadline layering: each outer budget must outlast the one inside it.
 *
 * The incident these tests exist for was one misreading repeated at every
 * layer — a slow query read as a dead provider — and the mechanism that made
 * it user-visible was deadlines firing in the wrong order. When an OUTER
 * deadline fires first, the layer that could actually explain the failure
 * never gets to answer: the proxy returns an opaque 504 instead of the app's
 * structured one, or the browser aborts a scan the server was about to
 * finish and retries it, doubling load on the query that was already slow.
 *
 * The order that has to hold, innermost first:
 *
 *   FalkorDB query budget  <  ASGI tier  <  client timeout  <  proxy timeout
 *
 * The server-side numbers below are mirrored from
 * `backend/app/config/resilience.py` and the tier table in
 * `backend/app/main.py::_TimeoutMiddleware`. Their side of the invariant is
 * pinned by `backend/tests/test_timeout_middleware.py`; this pins the client
 * side, which no backend test can see.
 */
import { describe, expect, it } from 'vitest'

import { TIMEOUTS } from '../timeouts'

/** Slowest the backend can spend inside a request, per endpoint (seconds). */
const SERVER_BUDGET_S = {
  'POST /nodes/query': 20,          // FALKORDB_NODES_QUERY_TIMEOUT
  'POST /edges/between': 40,        // FALKORDB_EDGES_BETWEEN_TIMEOUT
  'POST /edges/aggregated': 30,     // FALKORDB_AGGREGATED_READ_TIMEOUT_SECS
  'GET /nodes/top-level': 35,       // TOP_LEVEL 30 + best-effort COUNT 5
  'GET /children-with-edges': 30,   // the children page, then its edges, at 15 each
  'POST /trace/v2': 60,             // TRACE_TIMEOUT_SECS
} as const

/** The ASGI tier wrapped around each (seconds). */
const ASGI_TIER_S = {
  'POST /nodes/query': 60,          // HTTP_TIMEOUT_GRAPH_SECS
  'POST /edges/between': 45,        // HTTP_TIMEOUT_AGGREGATION_SECS
  'POST /edges/aggregated': 45,
  'GET /nodes/top-level': 60,
  'GET /children-with-edges': 60,
  'POST /trace/v2': 60,             // HTTP_TIMEOUT_TRACE_SECS
} as const

const CLIENT_MS = {
  'POST /nodes/query': TIMEOUTS.NODES_QUERY_MS,
  'POST /edges/between': TIMEOUTS.EDGES_BETWEEN_MS,
  'POST /edges/aggregated': TIMEOUTS.AGGREGATED_EDGES_MS,
  'GET /nodes/top-level': TIMEOUTS.TOP_LEVEL_MS,
  'GET /children-with-edges': TIMEOUTS.GET_CHILDREN_MS,
  'POST /trace/v2': TIMEOUTS.TRACE_MS,
} as const

/** nginx `proxy_read_timeout`, the GCLB `timeoutSec`, and the ingress
 *  annotation — all 180s, and every client budget must stay under them so a
 *  proxy never wins the race. */
const PROXY_S = 180

type Endpoint = keyof typeof SERVER_BUDGET_S
const ENDPOINTS = Object.keys(SERVER_BUDGET_S) as Endpoint[]

describe('client deadlines outlast the backend budgets underneath them', () => {
  it.each(ENDPOINTS)('%s gives the backend room to answer first', (endpoint) => {
    const clientS = CLIENT_MS[endpoint] / 1000
    const serverS = SERVER_BUDGET_S[endpoint]

    // 10s of headroom over the query budget itself: the request still has to
    // wait for a provider slot, serialize a response that can reach the 4 MiB
    // cache cap, and cross a link the user may be sharing with three sibling
    // batches.
    expect(clientS).toBeGreaterThanOrEqual(serverS + 10)
  })

  it.each(ENDPOINTS)('%s never ties the ASGI tier around it', (endpoint) => {
    const clientS = CLIENT_MS[endpoint] / 1000
    const tierS = ASGI_TIER_S[endpoint]

    // A tie is a coin flip over which layer explains the failure. Either the
    // client outlasts the tier (the middleware's structured 504 wins) or it
    // gives up well before it — never at the same instant.
    expect(clientS).not.toBe(tierS)
    if (clientS < tierS) {
      expect(clientS).toBeLessThanOrEqual(tierS - 10)
    }
  })

  it.each(ENDPOINTS)('%s stays under the proxy timeout', (endpoint) => {
    expect(CLIENT_MS[endpoint] / 1000).toBeLessThan(PROXY_S)
  })

  it('every hot graph read sets an explicit budget rather than the default', () => {
    // The canvas hydration path inherited DEFAULT_MS for a long time, leaving
    // 10s over its 20s server budget — the thinnest margin of any graph read,
    // on the request fired four-at-a-time on every view open.
    for (const endpoint of ENDPOINTS) {
      expect(CLIENT_MS[endpoint]).not.toBe(TIMEOUTS.DEFAULT_MS)
    }
  })
})
