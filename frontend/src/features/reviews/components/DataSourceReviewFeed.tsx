/**
 * DataSourceReviewFeed — headless: resolves one data source → its graph, lists that
 * graph's PRs, and lifts them to the inbox. One instance per data source keeps hook order
 * stable while fanning out (the backend lists PRs per graph). Renders nothing.
 */
import { useEffect } from 'react'
import { useResolveGraph, useMergeRequests } from '../../versioning/hooks/useVersioning'
import type { PullRequest } from '@/services/versioningApiService'

export type ReviewItem = { pr: PullRequest; sourceLabel: string }

export function DataSourceReviewFeed({
  wsId, dataSourceId, sourceLabel, onLoaded,
}: {
  wsId: string
  dataSourceId: string
  sourceLabel: string
  onLoaded: (dataSourceId: string, items: ReviewItem[]) => void
}) {
  const resolve = useResolveGraph(wsId, dataSourceId)
  const graphId = resolve.data?.graphId ?? null
  const mrs = useMergeRequests(wsId, graphId)

  useEffect(() => {
    if (mrs.data) onLoaded(dataSourceId, mrs.data.map((pr) => ({ pr, sourceLabel })))
    else if (resolve.isError) onLoaded(dataSourceId, []) // no versioned graph → no PRs
  }, [mrs.data, resolve.isError, dataSourceId, sourceLabel, onLoaded])

  return null
}
