/**
 * traceHistoryStack — browser-style back/forward over the user's traces
 * (per view), with localStorage round-tripping.
 *
 * Semantics under test (the Lens's lensHistory rules, over rich entries):
 *  - pushing a NEW focal truncates the forward side;
 *  - pushing the CURRENT focal never adds an entry — it updates the
 *    current entry's view params in place (a Root Cause → Impact flip on
 *    the same node is one trace, not two);
 *  - back/forward move the cursor without dropping entries; jump goes
 *    anywhere; all three are no-ops at the ends / out of range;
 *  - updateCurrent records the view params the user leaves behind, so
 *    "back" restores the trace AS IT WAS VIEWED;
 *  - serialize caps the stored entries (oldest pruned, cursor adjusted);
 *    hydrate tolerates junk and version drift by starting empty.
 */
import { describe, it, expect } from 'vitest'
import {
  emptyTraceHistory,
  pushTraceFocal,
  updateCurrentTraceView,
  traceHistoryBack,
  traceHistoryForward,
  traceHistoryJump,
  currentTraceEntry,
  serializeTraceHistory,
  hydrateTraceHistory,
  TRACE_HISTORY_CAP,
  type TraceHistoryStack,
  type TraceViewParams,
} from '../traceHistoryStack'

const view = (over: Partial<TraceViewParams> = {}): TraceViewParams =>
  ({ showUpstream: true, showDownstream: true, depthUp: 25, depthDown: 25, traceExpansion: [], ...over })

const push = (h: TraceHistoryStack, urn: string, ts = 1000) =>
  pushTraceFocal(h, { urn, focusId: `id:${urn}`, view: view(), timestamp: ts })

describe('traceHistoryStack', () => {
  it('X → Y → Z, back to Y, back to X, forward to Y — nothing dropped', () => {
    let h = push(push(push(emptyTraceHistory(), 'X'), 'Y'), 'Z')
    expect(currentTraceEntry(h)?.urn).toBe('Z')
    h = traceHistoryBack(h)
    expect(currentTraceEntry(h)?.urn).toBe('Y')
    h = traceHistoryBack(h)
    expect(currentTraceEntry(h)?.urn).toBe('X')
    h = traceHistoryBack(h)   // at the start — no-op
    expect(currentTraceEntry(h)?.urn).toBe('X')
    h = traceHistoryForward(h)
    expect(currentTraceEntry(h)?.urn).toBe('Y')
    expect(h.entries.map(e => e.urn)).toEqual(['X', 'Y', 'Z'])
  })

  it('pushing a new focal from mid-history truncates the forward side', () => {
    let h = push(push(push(emptyTraceHistory(), 'X'), 'Y'), 'Z')
    h = traceHistoryBack(traceHistoryBack(h))   // at X
    h = push(h, 'W')
    expect(h.entries.map(e => e.urn)).toEqual(['X', 'W'])
    expect(currentTraceEntry(h)?.urn).toBe('W')
  })

  it('re-pushing the current focal updates its view params in place — no new entry', () => {
    let h = push(push(emptyTraceHistory(), 'X'), 'Y')
    h = pushTraceFocal(h, { urn: 'Y', focusId: 'id:Y', view: view({ showDownstream: false }), timestamp: 2000 })
    expect(h.entries.map(e => e.urn)).toEqual(['X', 'Y'])
    expect(currentTraceEntry(h)?.view.showDownstream).toBe(false)
    expect(currentTraceEntry(h)?.timestamp).toBe(2000)
  })

  it('updateCurrent records the view the user leaves behind; jump restores it', () => {
    let h = push(push(emptyTraceHistory(), 'X'), 'Y')
    h = traceHistoryBack(h)   // viewing X
    h = updateCurrentTraceView(h, view({ depthUp: 2, showDownstream: false }))
    h = traceHistoryJump(h, 1)   // to Y
    expect(currentTraceEntry(h)?.urn).toBe('Y')
    h = traceHistoryJump(h, 0)   // back to X
    expect(currentTraceEntry(h)?.view.depthUp).toBe(2)
    expect(currentTraceEntry(h)?.view.showDownstream).toBe(false)
    expect(traceHistoryJump(h, 99)).toBe(h)   // out of range — no-op
  })

  it('serialize caps at TRACE_HISTORY_CAP, pruning oldest and keeping the cursor on the same entry', () => {
    let h = emptyTraceHistory()
    for (let i = 0; i < TRACE_HISTORY_CAP + 10; i++) h = push(h, `u${i}`, i)
    const raw = serializeTraceHistory(h)
    const back = hydrateTraceHistory(raw)
    expect(back.entries.length).toBe(TRACE_HISTORY_CAP)
    expect(back.entries[0]!.urn).toBe('u10')   // oldest 10 pruned
    expect(currentTraceEntry(back)?.urn).toBe(`u${TRACE_HISTORY_CAP + 9}`)
  })

  it('hydrate tolerates junk, empty, and version drift', () => {
    expect(hydrateTraceHistory(null).entries).toEqual([])
    expect(hydrateTraceHistory('not json').entries).toEqual([])
    expect(hydrateTraceHistory('{"v":99,"entries":[{}]}').entries).toEqual([])
    expect(hydrateTraceHistory('{"v":1,"entries":"nope","cursor":0}').entries).toEqual([])
  })

  it('round-trips a real stack byte-for-byte', () => {
    let h = push(push(emptyTraceHistory(), 'X', 5), 'Y', 9)
    h = traceHistoryBack(h)
    const back = hydrateTraceHistory(serializeTraceHistory(h))
    expect(back).toEqual(h)
  })
})

/**
 * THE EXPANSION PICTURE (F8). An entry records not just WHERE the reader
 * traced and which way they were looking, but WHICH CARDS THEY HAD OPEN —
 * otherwise "back" restores a trace collapsed back to its seed, which is
 * not the trace they left.
 *
 * The set is normalized (sorted, deduped) on the way in so two identical
 * pictures serialize identically, and an EMPTY array means "as the trace
 * opened" — the seed, not "everything closed". A trace the reader never
 * touched therefore records nothing and restores to its own seed.
 */
describe('traceHistoryStack — the expansion picture', () => {
  it('carries traceExpansion through push, updateCurrent and jump', () => {
    let h = pushTraceFocal(emptyTraceHistory(), {
      urn: 'X', focusId: 'id:X', view: view(), timestamp: 1,
    })
    h = updateCurrentTraceView(h, view({ traceExpansion: ['tableau', 'cfo'] }))
    expect(currentTraceEntry(h)?.view.traceExpansion).toEqual(['cfo', 'tableau'])

    h = pushTraceFocal(h, { urn: 'Y', focusId: 'id:Y', view: view(), timestamp: 2 })
    expect(currentTraceEntry(h)?.view.traceExpansion).toEqual([])
    h = traceHistoryJump(h, 0)
    expect(currentTraceEntry(h)?.view.traceExpansion).toEqual(['cfo', 'tableau'])
  })

  it('normalizes on the way in — sorted and deduped', () => {
    let h = pushTraceFocal(emptyTraceHistory(), {
      urn: 'X', focusId: 'id:X', view: view({ traceExpansion: ['b', 'a', 'b', 'c', 'a'] }), timestamp: 1,
    })
    expect(currentTraceEntry(h)?.view.traceExpansion).toEqual(['a', 'b', 'c'])
    h = updateCurrentTraceView(h, view({ traceExpansion: ['z', 'z'] }))
    expect(currentTraceEntry(h)?.view.traceExpansion).toEqual(['z'])
  })

  it('round-trips the expansion through storage', () => {
    let h = pushTraceFocal(emptyTraceHistory(), {
      urn: 'X', focusId: 'id:X', view: view({ traceExpansion: ['orders', 'cfo'] }), timestamp: 7,
    })
    h = pushTraceFocal(h, { urn: 'Y', focusId: 'id:Y', view: view(), timestamp: 8 })
    const back = hydrateTraceHistory(serializeTraceHistory(h))
    expect(back).toEqual(h)
    expect(back.entries[0]!.view.traceExpansion).toEqual(['cfo', 'orders'])
  })

  // History written before F8 is still the user's history. It loads, it
  // just has no picture to restore — which is exactly what an empty
  // expansion means anyway.
  it('loads pre-F8 entries that have no traceExpansion at all, as []', () => {
    const legacy = JSON.stringify({
      v: 1,
      cursor: 0,
      entries: [{
        urn: 'X', focusId: 'id:X', timestamp: 3,
        view: { showUpstream: true, showDownstream: false, depthUp: 25, depthDown: 25 },
      }],
    })
    const h = hydrateTraceHistory(legacy)
    expect(h.entries.length).toBe(1)
    expect(h.entries[0]!.view.traceExpansion).toEqual([])
    expect(h.entries[0]!.view.showDownstream).toBe(false)
  })

  it('rejects a malformed expansion rather than half-loading it', () => {
    const junk = JSON.stringify({
      v: 1,
      cursor: 0,
      entries: [{
        urn: 'X', focusId: 'id:X', timestamp: 3,
        view: { showUpstream: true, showDownstream: true, depthUp: 25, depthDown: 25, traceExpansion: 'cfo' },
      }],
    })
    expect(hydrateTraceHistory(junk).entries).toEqual([])
  })
})
