/**
 * The hidden steps behind one virtual hop, arranged for a reader.
 *
 * The walk answers at RAW grain — often column to column — but a person asked
 * "how does this table reach that one?", so the steps are shown at the grain
 * the view itself speaks: each hidden node is filed under its nearest
 * container of the same type as the two members (a column under its table),
 * or stands for itself when it has none. Steps are laid out by distance from
 * the source, so a level with more than one entry is a place where routes of
 * equal length run side by side.
 */
import type { LineageBridgePathResult } from '@/providers/GraphDataProvider'

export interface BridgeStep {
  /** The entity shown: the hidden node, or its container at the members' grain. */
  urn: string
  name: string
  entityType: string
  /** Where it sits, outermost first — at most the two nearest containers. */
  context: string[]
  /** How many raw hidden nodes it stands for. */
  nodes: number
}

export interface BridgePathModel {
  /** Raw lineage edges on the shortest route; null when there is none now. */
  hops: number | null
  /** Hidden steps by distance from the source: `levels[0]` is the first
   *  step. A level holding several is where equal-length routes diverge. */
  levels: BridgeStep[][]
  /** One concrete route at the shown grain, both members included — what a
   *  Lens trail walks. Empty when there is no route. */
  trail: string[]
}

/** What a virtual hop of `hops` raw edges leaves out: every edge but the
 *  last lands on a node the view does not hold. */
export function hiddenStepsLabel(hops: number): string {
  const steps = Math.max(1, hops - 1)
  return `via ${steps} hidden step${steps === 1 ? '' : 's'}`
}

function lastSegment(urn: string): string {
  const parts = urn.split(/[:/.]/).filter(Boolean)
  return parts[parts.length - 1] ?? urn
}

export function buildBridgePathModel(result: LineageBridgePathResult): BridgePathModel {
  if (result.hops == null) return { hops: null, levels: [], trail: [] }

  const byUrn = new Map(result.nodes.map(n => [n.urn, n]))
  const chains = result.ancestorChains ?? {}
  const hidden = new Set(result.hiddenUrns)
  const grainTypes = new Set(
    [result.source, result.target]
      .map(urn => byUrn.get(urn)?.entityType)
      .filter((t): t is string => !!t),
  )

  // The shown entity for a hidden node: itself at the members' grain, else
  // its nearest container that is.
  const shownFor = (urn: string): string => {
    if (grainTypes.size === 0) return urn
    for (const candidate of [urn, ...(chains[urn] ?? [])]) {
      const type = byUrn.get(candidate)?.entityType
      if (type && grainTypes.has(type)) return candidate
    }
    return urn
  }

  // Distance from the source side. Every route edge leaves a node the source
  // owns or a hidden one, so the route's starts are the tails not hidden.
  const out = new Map<string, string[]>()
  for (const e of result.edges) {
    const list = out.get(e.sourceUrn)
    if (list) list.push(e.targetUrn)
    else out.set(e.sourceUrn, [e.targetUrn])
  }
  const starts = [...out.keys()].filter(u => !hidden.has(u))
  const level = new Map<string, number>()
  let frontier = starts
  for (let depth = 1; frontier.length > 0; depth++) {
    const next: string[] = []
    for (const u of frontier) {
      for (const v of out.get(u) ?? []) {
        if (!hidden.has(v) || level.has(v)) continue
        level.set(v, depth)
        next.push(v)
      }
    }
    frontier = next
  }

  const levels: BridgeStep[][] = []
  const grouped = new Map<string, BridgeStep>()
  for (const urn of result.hiddenUrns) {
    const depth = level.get(urn)
    if (depth === undefined) continue
    const shown = shownFor(urn)
    const key = `${depth}\u0000${shown}`
    const existing = grouped.get(key)
    if (existing) { existing.nodes++; continue }
    const node = byUrn.get(shown)
    const step: BridgeStep = {
      urn: shown,
      name: node?.displayName || lastSegment(shown),
      entityType: node?.entityType ?? '',
      context: (chains[shown] ?? []).slice(0, 2).reverse()
        .map(a => byUrn.get(a)?.displayName || lastSegment(a)),
      nodes: 1,
    }
    grouped.set(key, step)
    while (levels.length < depth) levels.push([])
    levels[depth - 1].push(step)
  }

  // One route: follow the first edge at each step, from the first start.
  const trail = [result.source]
  let at = starts[0]
  for (let guard = 0; at !== undefined && guard <= result.hops; guard++) {
    const next: string | undefined = (out.get(at) ?? []).find(v => hidden.has(v))
    if (next === undefined) break
    const shown = shownFor(next)
    if (trail[trail.length - 1] !== shown) trail.push(shown)
    at = next
  }
  if (trail[trail.length - 1] !== result.target) trail.push(result.target)

  // A route that stays inside one shown entity for several raw steps (column
  // to column within a table) is ONE step at this grain.
  const merged: BridgeStep[][] = []
  for (const lvl of levels) {
    if (lvl.length === 0) continue
    const prev = merged[merged.length - 1]
    if (prev && prev.length === 1 && lvl.length === 1 && prev[0].urn === lvl[0].urn) {
      prev[0].nodes += lvl[0].nodes
      continue
    }
    merged.push(lvl)
  }

  return { hops: result.hops, levels: merged, trail }
}
