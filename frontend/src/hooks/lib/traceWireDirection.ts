/**
 * WHICH WAY A TRACE WIRE RUNS — measured against the lanes the TRACE itself
 * draws, never against the browse layer map.
 *
 * During a trace the board is `overlay.view.lanes`; a card the walk brought
 * in sits in none of the browse layers. Measured against that map, "unknown"
 * became "Source" (layer 0), so with the focus anywhere below Source EVERY
 * downstream wire read as running backwards — re-routed through the
 * overlay's back-arc and printed as `←` in the Connections panel, in the
 * panel whose whole thesis is that its numbers are honest.
 *
 * An endpoint nobody placed is not evidence of anything: BOTH ends must
 * resolve before a wire is called reverse, exactly as the browse projection
 * already requires. Unknown falls back to "not reverse", never to layer 0.
 */

/** urn → lane ordinal. The lanes arrive in the view's own layer order. */
export function buildTraceLaneIndex(
  lanes: ReadonlyArray<{ cards: ReadonlyMap<string, unknown> }> | undefined,
): Map<string, number> {
  const index = new Map<string, number>()
  lanes?.forEach((lane, ordinal) => {
    lane.cards.forEach((_card, urn) => index.set(urn, ordinal))
  })
  return index
}

/** True only when both ends are placed and the wire runs back up the lanes. */
export function isReverseTraceWire(
  wire: { source: string; target: string },
  laneIndex: ReadonlyMap<string, number>,
): boolean {
  const source = laneIndex.get(wire.source)
  const target = laneIndex.get(wire.target)
  return typeof source === 'number' && typeof target === 'number' && target < source
}
