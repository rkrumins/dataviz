/**
 * The picks as the create request carries them (`POST /views/{id}/subsets`).
 */
import type { ViewSubsetCreateRequest, ViewSubsetMember } from '@/services/viewApiService'

import type { SubsetPick } from './studioStore'

export function subsetMembers(picks: readonly SubsetPick[], keepGroups: boolean): ViewSubsetMember[] {
  return picks.map(p => ({
    urn: p.urn,
    layerId: p.layerId,
    ...(keepGroups && p.logicalNodeId ? { logicalNodeId: p.logicalNodeId } : {}),
    inheritsChildren: p.inheritsChildren,
  }))
}

export function subsetRequest(opts: {
  name: string
  description: string
  tags: readonly string[]
  visibility: string
  picks: readonly SubsetPick[]
  keepGroups: boolean
  maxHops: number
}): ViewSubsetCreateRequest {
  const description = opts.description.trim()
  return {
    name: opts.name.trim(),
    ...(description ? { description } : {}),
    ...(opts.tags.length > 0 ? { tags: [...opts.tags] } : {}),
    visibility: opts.visibility,
    members: subsetMembers(opts.picks, opts.keepGroups),
    connectivity: { mode: 'bridged', maxHops: opts.maxHops },
  }
}
