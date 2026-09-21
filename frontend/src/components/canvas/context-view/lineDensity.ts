/**
 * How much each line carries as the board fills up.
 *
 *   premium   (≤ 200 lines) — per-line gradient, dashed roll-ups
 *   standard  (≤ 800)       — solid colour strokes
 *   coalesced (> 800)       — the same, and hit paths go focus-only
 *
 * The tier is sticky by 10% either side of each boundary. Lines land in
 * batches as data arrives, and a count hovering at 200 flipped the whole
 * board's look — gradients, dashes — on every batch.
 */
export type RenderTier = 'premium' | 'standard' | 'coalesced'

const TIERS: readonly RenderTier[] = ['premium', 'standard', 'coalesced']
const PREMIUM_MAX = 200
const STANDARD_MAX = 800
const STICKY = 0.1

export function nextRenderTier(count: number, current: RenderTier): RenderTier {
  const rank = TIERS.indexOf(current)
  // A boundary is further away in whichever direction would leave the
  // current tier.
  const bound = (limit: number, lowerTier: number) =>
    rank <= lowerTier ? limit * (1 + STICKY) : limit * (1 - STICKY)
  if (count <= bound(PREMIUM_MAX, 0)) return 'premium'
  if (count <= bound(STANDARD_MAX, 1)) return 'standard'
  return 'coalesced'
}

/**
 * A roll-up's dash, only where it can be read: on a sparse board, or on a line
 * the reader is looking at. Past that, hundreds of dashed curves fanning into
 * the same cards interfere into a moiré that reads as the canvas breaking up,
 * and the roll-up draws solid. Every other dash is the ontology's own stroke
 * style for the type, and always stays.
 */
export function lineDash(line: { isGhost: boolean; dashArray: string }, detailed: boolean): string {
  return line.isGhost && !detailed ? 'none' : line.dashArray
}

/**
 * The order every line budget rations room by: how many lines this one
 * replaces (`bundleSize`), NOT `edgeCount`, the weight the bundle stands for.
 *
 * Those diverge on a roll-up: a "Combined flow" can speak for thousands of
 * table-level flows while occupying exactly one line. Ranking on the weight
 * let such a roll-up outrank, and therefore evict, the raw edges a user had
 * just expanded a container to see — lineage vanishing at the moment they
 * asked for more of it. `edgeCount` remains the weight everywhere it is read
 * for display; only the budget's ordering uses this.
 */
export function bySignificance(
  a: { bundleSize?: number; edgeCount?: number; confidence?: number },
  b: { bundleSize?: number; edgeCount?: number; confidence?: number },
): number {
  return ((b.bundleSize ?? b.edgeCount ?? 1) - (a.bundleSize ?? a.edgeCount ?? 1))
    || ((b.confidence || 0) - (a.confidence || 0))
}
