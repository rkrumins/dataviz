/**
 * DataSourceReviewFeed — headless: lists one data source's PRs and lifts them to the inbox.
 * Its open PRs (status=open: not yet merged or closed) are read on their own, so newer merged or
 * closed PRs can't push an older one awaiting review off the latest page of every status. One
 * instance per data source keeps hook order stable while fanning out. Renders nothing.
 */
import { useEffect } from 'react'
import { useDataSourcePullRequests } from '../../versioning/hooks/useVersioning'
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
  const open = useDataSourcePullRequests(wsId, dataSourceId, 'open')
  const latest = useDataSourcePullRequests(wsId, dataSourceId)

  useEffect(() => {
    if (open.data && latest.data) {
      const byId = new Map([...latest.data, ...open.data].map((pr) => [pr.prId, pr]))
      onLoaded(dataSourceId, [...byId.values()].map((pr) => ({ pr, sourceLabel })))
    } else if (open.isError || latest.isError) onLoaded(dataSourceId, []) // no versioned graph → no PRs
  }, [open.data, latest.data, open.isError, latest.isError, dataSourceId, sourceLabel, onLoaded])

  return null
}
