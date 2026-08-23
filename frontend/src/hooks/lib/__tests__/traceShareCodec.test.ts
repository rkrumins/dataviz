/**
 * A trace is a FINDING — "what feeds this dashboard", "what breaks if I drop
 * this column" — and findings get handed to other people. Today that means a
 * screenshot, which cannot be re-read, re-directed or re-opened. This codec
 * turns the trace on screen into a link that reopens it.
 *
 * The shared state is exactly what the history stack already records (see
 * traceHistoryStack): the focus, the direction, the hop limits, and which
 * cards the sender had open. Plus the sender's NAME for the focus, so the
 * recipient's loading capsule says what it is fetching instead of a urn tail.
 *
 * The decode rule is the Lens codec's, for the same reason: a link arrives
 * from outside and must never be able to break the canvas. Anything
 * malformed — bad base64, bad JSON, wrong version, wrong shapes, a hostile
 * depth — returns null and the view opens normally.
 */
import { describe, it, expect } from 'vitest'
import { encodeTraceShare, decodeTraceShare, TRACE_SHARE_OPEN_CAP } from '../traceShareCodec'

const state = {
  urn: 'urn:li:dashboard:customer_360_de06a1ba',
  label: 'Customer 360 Dashboard',
  up: true,
  down: true,
  depthUp: 25,
  depthDown: 25,
  open: ['urn:li:container:gold_af963e43', 'urn:li:dataset:dim_customer_aae7a84b'],
}

describe('encode → decode', () => {
  it('round-trips the whole picture', () => {
    expect(decodeTraceShare(encodeTraceShare(state))).toEqual({ v: 1, ...state })
  })

  it('writes a URL-safe token — no +, / or = to be mangled in transit', () => {
    const token = encodeTraceShare({ ...state, label: 'Ünïcødé ✦ dashboard', open: Array.from({ length: 40 }, (_, i) => `urn:x:${i}`) })
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeTraceShare(token)?.label).toBe('Ünïcødé ✦ dashboard')
  })

  it('carries a one-sided trace as one-sided', () => {
    const rootCause = decodeTraceShare(encodeTraceShare({ ...state, up: true, down: false }))
    expect(rootCause).toMatchObject({ up: true, down: false })
  })

  it('an empty open-set is "as the trace opens" — carried, not invented', () => {
    expect(decodeTraceShare(encodeTraceShare({ ...state, open: [] }))?.open).toEqual([])
  })

  it('a label is optional — a sender who has no name for it sends none', () => {
    const decoded = decodeTraceShare(encodeTraceShare({ ...state, label: undefined }))
    expect(decoded?.urn).toBe(state.urn)
    expect(decoded?.label).toBeUndefined()
  })
})

describe('a link from outside can never break the canvas', () => {
  const rejects = (token: string) => expect(decodeTraceShare(token)).toBeNull()

  it('rejects junk, empty strings and non-JSON', () => {
    rejects('')
    rejects('not base64 !!')
    rejects(btoa('{"v":1,'))
  })

  it('rejects a token that is not an object, or is the wrong version', () => {
    rejects(btoa(JSON.stringify([1, 2, 3])))
    rejects(btoa(JSON.stringify('a string')))
    rejects(btoa(JSON.stringify({ v: 2, ...state })))
    rejects(btoa(JSON.stringify({ ...state })))
  })

  it('rejects a missing or empty focus — there is nothing to trace', () => {
    rejects(btoa(JSON.stringify({ v: 1, ...state, urn: '' })))
    rejects(btoa(JSON.stringify({ v: 1, ...state, urn: undefined })))
    rejects(btoa(JSON.stringify({ v: 1, ...state, urn: 42 })))
  })

  it('rejects a trace with no direction at all', () => {
    rejects(btoa(JSON.stringify({ v: 1, ...state, up: false, down: false })))
    rejects(btoa(JSON.stringify({ v: 1, ...state, up: 'yes' })))
  })

  it('rejects a depth the control itself could never ask for', () => {
    rejects(btoa(JSON.stringify({ v: 1, ...state, depthUp: 26 })))
    rejects(btoa(JSON.stringify({ v: 1, ...state, depthDown: -1 })))
    rejects(btoa(JSON.stringify({ v: 1, ...state, depthUp: Infinity })))
    rejects(btoa(JSON.stringify({ v: 1, ...state, depthUp: '25' })))
  })

  it('rejects an open-set that is not a list of urns', () => {
    rejects(btoa(JSON.stringify({ v: 1, ...state, open: 'gold' })))
    rejects(btoa(JSON.stringify({ v: 1, ...state, open: [1, 2] })))
    rejects(btoa(JSON.stringify({ v: 1, ...state, open: undefined })))
  })

  it('truncates rather than trusts an oversized open-set', () => {
    const many = Array.from({ length: TRACE_SHARE_OPEN_CAP + 500 }, (_, i) => `urn:x:${i}`)
    // The encoder never writes more than the cap…
    expect(decodeTraceShare(encodeTraceShare({ ...state, open: many }))?.open).toHaveLength(TRACE_SHARE_OPEN_CAP)
    // …and a hand-written token that does is cut down to it, not obeyed.
    const decoded = decodeTraceShare(btoa(JSON.stringify({ v: 1, ...state, open: many })))
    expect(decoded?.open).toHaveLength(TRACE_SHARE_OPEN_CAP)
  })

  it('truncates an absurd label rather than rendering it', () => {
    const decoded = decodeTraceShare(btoa(JSON.stringify({ v: 1, ...state, label: 'x'.repeat(5000) })))
    expect(decoded?.label?.length).toBeLessThanOrEqual(200)
  })

  it('a non-string label is dropped, not fatal — the urn still traces', () => {
    const decoded = decodeTraceShare(btoa(JSON.stringify({ v: 1, ...state, label: { evil: true } })))
    expect(decoded?.urn).toBe(state.urn)
    expect(decoded?.label).toBeUndefined()
  })
})
