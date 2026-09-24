/**
 * useSubsetGrow — bring a pick's upstream or downstream into the subset.
 *
 * WITHIN THE VIEW, lineage is read at the view's own grain: the links come
 * from the lineage-bridges walk over the source view's members (asked once
 * when the studio opens), so one step upstream of an entity is the nearest
 * entities of the view that feed it however many raw steps lie between, and
 * "all" follows that on to the view's edge — instantly, in memory. A pick
 * finer than the view's members (a column of a table the view holds) asks
 * the walk for its own first step.
 *
 * BEYOND THE VIEW (opt-in), each pick's raw one-step neighbours are asked
 * of the lineage closure and filed under their container at the pick's own
 * grain (a column under its table), then placed by the view's layer rules —
 * or one layer beyond the pick they came from.
 */
import { useCallback, useMemo } from 'react'

import { useGraphProvider } from '@/providers'
import {
  sortLayerRules,
  type GraphNode,
  type LayerAssignmentRule,
  type LineageBridgeLink,
  type LineageBridgeMember,
} from '@/providers/GraphDataProvider'

import { memberGraph, reachFrom, type GrowDepth, type GrowDirection } from '../model/grow'
import { placeOutside } from '../model/placement'
import { orderedPicks, useSubsetStudioStore, type SubsetPick } from '../model/studioStore'

/** Beyond the view, one closure per pick: a grow asks for at most this many. */
export const REACH_BEYOND_PICK_CAP = 25
const REACH_BEYOND_CONCURRENCY = 4
const REACH_BEYOND_MAX_NODES = 2000

/** What the source view says about one of its members. */
export interface SourceMember {
  urn: string
  layerId: string
  logicalNodeId?: string
  inheritsChildren: boolean
  label: string
  entityType?: string
}

export interface GrowOutcome {
  /** New entities, nearest first — none already picked. */
  additions: SubsetPick[]
  /** Beyond the view, picks past the cap were not asked about. */
  skippedPicks: number
  /** Some of the asks failed; what came back is still here. */
  partial: boolean
}

export interface UseSubsetGrowOptions {
  /** The source view's members, by urn. */
  sourceMembers: ReadonlyMap<string, SourceMember>
  /** Links among them (the bridges walk over the source members). */
  sourceLinks: readonly LineageBridgeLink[]
  maxHops: number
  /** The source view's layers, in order, and their compiled rules. */
  layerOrder: readonly string[]
  layerRules: readonly LayerAssignmentRule[]
}

function directionPartners(
  links: readonly LineageBridgeLink[],
  from: ReadonlySet<string>,
  direction: GrowDirection,
): string[] {
  return links
    .filter(l => (direction === 'downstream' ? from.has(l.source) : from.has(l.target)))
    .map(l => (direction === 'downstream' ? l.target : l.source))
}

async function inBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(run))
  }
}

export function useSubsetGrow({
  sourceMembers,
  sourceLinks,
  maxHops,
  layerOrder,
  layerRules,
}: UseSubsetGrowOptions) {
  const provider = useGraphProvider()
  const graph = useMemo(() => memberGraph(sourceLinks), [sourceLinks])
  const sortedRules = useMemo(() => sortLayerRules([...layerRules]), [layerRules])

  const grow = useCallback(async (direction: GrowDirection, depth: GrowDepth): Promise<GrowOutcome> => {
    const state = useSubsetStudioStore.getState()
    const picks = orderedPicks(state)
    const picked = new Set(picks.map(p => p.urn))
    const origin = direction === 'upstream' ? 'grown-up' : 'grown-down'
    let partial = false

    // ── Within the view ──
    const memberPicks = picks.filter(p => sourceMembers.has(p.urn)).map(p => p.urn)
    const finer = picks.filter(p => !sourceMembers.has(p.urn) && p.origin !== 'outside')
    const firstStep = new Set(reachFrom(graph, memberPicks, direction, 'one'))
    if (finer.length > 0 && typeof provider.getLineageBridges === 'function') {
      const members: LineageBridgeMember[] = [
        ...[...sourceMembers.values()].filter(m => !picked.has(m.urn)).map(m => ({ urn: m.urn, inheritsChildren: m.inheritsChildren })),
        ...picks.filter(p => p.origin !== 'outside').map(p => ({ urn: p.urn, inheritsChildren: p.inheritsChildren })),
      ]
      try {
        const res = await provider.getLineageBridges({
          members, origins: finer.map(p => p.urn), direction, maxHops,
        })
        for (const n of directionPartners(res.links, new Set(finer.map(p => p.urn)), direction)) {
          if (sourceMembers.has(n)) firstStep.add(n)
        }
        if (res.truncated || res.incomplete.length > 0) partial = true
      } catch {
        partial = true
      }
    }
    const within = depth === 'all'
      ? [...firstStep, ...reachFrom(graph, [...memberPicks, ...firstStep], direction, 'all')]
      : [...firstStep]

    const additions: SubsetPick[] = []
    const taken = new Set(picked)
    for (const urn of within) {
      if (taken.has(urn)) continue
      const m = sourceMembers.get(urn)
      if (!m) continue
      taken.add(urn)
      additions.push({
        urn, layerId: m.layerId, logicalNodeId: m.logicalNodeId, inheritsChildren: m.inheritsChildren,
        origin, label: m.label, entityType: m.entityType,
      })
    }

    // ── Beyond the view ──
    let skippedPicks = 0
    if (state.reachBeyond && typeof provider.traceClosure === 'function') {
      const asked = picks.slice(0, REACH_BEYOND_PICK_CAP)
      skippedPicks = picks.length - asked.length
      await inBatches(asked, REACH_BEYOND_CONCURRENCY, async (p) => {
        try {
          const res = await provider.traceClosure!({
            urn: p.urn,
            direction,
            upstreamDepth: direction === 'upstream' ? 1 : 0,
            downstreamDepth: direction === 'downstream' ? 1 : 0,
            maxNodes: REACH_BEYOND_MAX_NODES,
          })
          if (res.truncated) partial = true
          const byUrn = new Map<string, GraphNode>(res.nodes.map(n => [n.urn, n]))
          const parentOf = new Map<string, string>()
          for (const e of res.containmentEdges ?? []) parentOf.set(e.targetUrn, e.sourceUrn)
          const partners = direction === 'upstream' ? res.upstreamUrns : res.downstreamUrns
          for (const partner of partners) {
            // Walk up to the pick's grain; stop (and skip) inside the pick itself.
            let at: string | undefined = partner
            let shown: string | undefined
            const guard = new Set<string>()
            let inside = false
            while (at && !guard.has(at)) {
              guard.add(at)
              if (at === p.urn) { inside = true; break }
              if (!shown && p.entityType && byUrn.get(at)?.entityType === p.entityType) shown = at
              at = parentOf.get(at)
            }
            if (inside) continue
            const urn = shown ?? partner
            if (taken.has(urn)) continue
            taken.add(urn)
            const member = sourceMembers.get(urn)
            if (member) {
              additions.push({
                urn, layerId: member.layerId, logicalNodeId: member.logicalNodeId,
                inheritsChildren: member.inheritsChildren, origin, label: member.label, entityType: member.entityType,
              })
              continue
            }
            const node = byUrn.get(urn)
            if (!node) continue
            const place = placeOutside(node, sortedRules, layerOrder, p.layerId, direction)
            additions.push({
              urn, layerId: place.layerId, inheritsChildren: true, origin: 'outside',
              label: node.displayName || urn, entityType: node.entityType,
            })
          }
        } catch {
          partial = true
        }
      })
    }

    return { additions, skippedPicks, partial }
  }, [graph, sourceMembers, provider, maxHops, sortedRules, layerOrder])

  return { grow }
}
