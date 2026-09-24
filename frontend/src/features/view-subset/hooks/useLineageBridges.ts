/**
 * useLineageBridges — the virtual hops between a view's members, asked of the
 * graph live.
 *
 * One request answers for every member at once (`POST /lineage/bridges`): a
 * bounded walk over RAW lineage that says which member reaches which through
 * steps the member set leaves out, and in how many. Nothing is frozen into
 * the view — the answer is filed under the member set and the graph's
 * generation, so it is recomputed when either moves (the server re-walks only
 * after a write; a re-open is a cache hit on both sides).
 *
 * Honest by construction: an answer the walk could not finish comes back
 * `partial`, naming which members may be missing links; a view too large to
 * walk is `oversized`; and a server that does not offer the walk (switched
 * off, or a store without it) is `disabled` — the canvas then draws direct
 * lines only, as it did before subsets.
 */
import { useCallback, useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { useGraphProvider } from '@/providers'
import type {
  LineageBridgeIncomplete,
  LineageBridgeLink,
  LineageBridgeMember,
} from '@/providers/GraphDataProvider'

import { BRIDGE_MEMBERS_MAX, DEFAULT_MAX_HOPS } from '../model/limits'
import { memberSetKey } from '../model/memberSetKey'

export type LineageBridgesStatus =
  | 'idle' | 'loading' | 'ready' | 'partial' | 'error' | 'disabled' | 'oversized'

export interface LineageBridgesState {
  status: LineageBridgesStatus
  links: readonly LineageBridgeLink[]
  /** Members whose links may be missing on one side (only when `partial`). */
  incomplete: readonly LineageBridgeIncomplete[]
  /** Paths were still growing at `maxHops`: longer connections may exist. */
  depthLimited: boolean
  /** A refresh is in flight behind the answer on screen. */
  isFetching: boolean
  refetch: () => void
}

export interface UseLineageBridgesOptions {
  enabled: boolean
  members: readonly LineageBridgeMember[]
  maxHops?: number
  /** Anything that moves when the graph does (the main head commit seq,
   *  the canvas's cache epoch). */
  generation?: number | string
}

const EMPTY_LINKS: readonly LineageBridgeLink[] = []
const EMPTY_INCOMPLETE: readonly LineageBridgeIncomplete[] = []

/** A refusal that asking again will not change: the walk is switched off
 *  (403), unknown to this server (404), or unsupported by its store (501). */
export function isBridgesUnavailable(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status
  return status === 403 || status === 404 || status === 501
}

export function useLineageBridges({
  enabled,
  members,
  maxHops = DEFAULT_MAX_HOPS,
  generation = 0,
}: UseLineageBridgesOptions): LineageBridgesState {
  const provider = useGraphProvider()
  const wanted = enabled && typeof provider.getLineageBridges === 'function' && members.length > 0
  const oversized = members.length > BRIDGE_MEMBERS_MAX
  const active = wanted && !oversized
  // Hashed once per member list, not per render: the canvas re-renders on
  // every hover, and a list can hold two thousand members.
  const setKey = useMemo(() => (active ? memberSetKey(members) : ''), [active, members])

  const query = useQuery({
    queryKey: ['lineage-bridges', provider.scopeKey ?? '', setKey, maxHops, generation],
    queryFn: ({ signal }) => provider.getLineageBridges!({ members: [...members], maxHops }, { signal }),
    enabled: active,
    // The lines on screen stay while an edit re-asks: hops that blinked out
    // on every assignment would read as lineage coming and going.
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    gcTime: 10 * 60_000,
    retry: (failures, error) => !isBridgesUnavailable(error) && failures < 1,
  })

  const { refetch: refetchQuery } = query
  const refetch = useCallback(() => { void refetchQuery() }, [refetchQuery])

  const none = { links: EMPTY_LINKS, incomplete: EMPTY_INCOMPLETE, depthLimited: false, refetch }
  if (!wanted) return { status: 'idle', isFetching: false, ...none }
  if (oversized) return { status: 'oversized', isFetching: false, ...none }

  const data = query.data
  if (!data) {
    if (query.isError) {
      return { status: isBridgesUnavailable(query.error) ? 'disabled' : 'error', isFetching: query.isFetching, ...none }
    }
    return { status: 'loading', isFetching: true, ...none }
  }
  return {
    status: data.truncated || data.incomplete.length > 0 ? 'partial' : 'ready',
    links: data.links,
    incomplete: data.incomplete,
    depthLimited: data.depthLimited,
    isFetching: query.isFetching,
    refetch,
  }
}
