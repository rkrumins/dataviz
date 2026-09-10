/**
 * A trace wire's direction is read off the TRACE's own lanes.
 *
 * The bug this pins: measured against the browse layer map, a card the walk
 * brought in resolved to nothing and `?? 0` called that "Source" — so a
 * plain downstream flow out of a focus in any later layer was flagged as
 * running backwards, drew through the overlay's back-arc, and was counted
 * under `←` in the Connections panel.
 */
import { describe, it, expect } from 'vitest'
import { buildTraceLaneIndex, isReverseTraceWire } from '../traceWireDirection'

/** Two lanes in the view's layer order: Source, then Reporting. */
const lanes = [
  { layerId: 'source', cards: new Map([['orders', {}], ['returns', {}]]) },
  { layerId: 'reporting', cards: new Map([['cfo', {}]]) },
]
const laneIndex = buildTraceLaneIndex(lanes)

describe('isReverseTraceWire', () => {
  it('a wire running with the lane order is not reverse', () => {
    expect(isReverseTraceWire({ source: 'orders', target: 'cfo' }, laneIndex)).toBe(false)
  })

  it('a wire running back up the lanes is reverse', () => {
    expect(isReverseTraceWire({ source: 'cfo', target: 'orders' }, laneIndex)).toBe(true)
  })

  it('an endpoint no lane placed is unknown — never Source, so never reverse', () => {
    // The whole bug: `?? 0` made this one read as "the target is in Source",
    // which flags every downstream wire out of a later lane.
    expect(isReverseTraceWire({ source: 'cfo', target: 'nowhere' }, laneIndex)).toBe(false)
    expect(isReverseTraceWire({ source: 'nowhere', target: 'orders' }, laneIndex)).toBe(false)
  })
})
