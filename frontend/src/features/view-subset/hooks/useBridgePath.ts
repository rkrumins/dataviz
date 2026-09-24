/**
 * useBridgePath — the hidden steps behind ONE virtual hop, asked when the
 * reader asks "how?" (`POST /lineage/bridges/path`).
 *
 * Walked with the SAME member set and reach the line was drawn with, so the
 * steps shown are exactly the ones the line stands for — and when the graph
 * has moved on since, the answer says so (`hops: null`) rather than inventing
 * a route.
 */
import { useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { useGraphProvider } from '@/providers'
import type { LineageBridgeMember, LineageBridgePathResult } from '@/providers/GraphDataProvider'

import { DEFAULT_MAX_HOPS } from '../model/limits'
import { memberSetKey } from '../model/memberSetKey'
import { isBridgesUnavailable } from './useLineageBridges'

export type BridgePathStatus = 'idle' | 'loading' | 'ready' | 'error' | 'disabled'

export interface BridgePathState {
  status: BridgePathStatus
  result: LineageBridgePathResult | null
  refetch: () => void
}

export interface UseBridgePathOptions {
  /** The link to explain; null asks nothing. */
  link: { source: string; target: string } | null
  members: readonly LineageBridgeMember[]
  maxHops?: number
  generation?: number | string
}

export function useBridgePath({
  link,
  members,
  maxHops = DEFAULT_MAX_HOPS,
  generation = 0,
}: UseBridgePathOptions): BridgePathState {
  const provider = useGraphProvider()
  const active = !!link && typeof provider.getLineageBridgePath === 'function' && members.length > 0
  const setKey = useMemo(() => (active ? memberSetKey(members) : ''), [active, members])

  const query = useQuery({
    queryKey: [
      'lineage-bridge-path',
      provider.scopeKey ?? '',
      setKey,
      link?.source ?? '',
      link?.target ?? '',
      maxHops,
      generation,
    ],
    queryFn: ({ signal }) => provider.getLineageBridgePath!(
      { members: [...members], source: link!.source, target: link!.target, maxHops },
      { signal },
    ),
    enabled: active,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: (failures, error) => !isBridgesUnavailable(error) && failures < 1,
  })

  const { refetch: refetchQuery } = query
  const refetch = useCallback(() => { void refetchQuery() }, [refetchQuery])

  if (!active) return { status: 'idle', result: null, refetch }
  if (query.data) return { status: 'ready', result: query.data, refetch }
  if (query.isError) {
    return { status: isBridgesUnavailable(query.error) ? 'disabled' : 'error', result: null, refetch }
  }
  return { status: 'loading', result: null, refetch }
}
