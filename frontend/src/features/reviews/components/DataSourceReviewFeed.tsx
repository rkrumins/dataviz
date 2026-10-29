/**
 * DataSourceReviewFeed — headless: lists one data source's PRs and lifts them to the inbox.
 * Its open PRs (status=open: not yet merged or closed) are read on their own, so newer merged or
 * closed PRs can't push an older one awaiting review off the latest page of every status. If one
 * read fails (other than the 404 of a data source with no versioned graph), what the other loaded
 * is still lifted, flagged as failed. One instance per data source keeps hook order stable while
 * fanning out. Renders nothing.
 */
import { useEffect } from 'react'
import { useDataSourcePullRequests } from '../../versioning/hooks/useVersioning'
import type { PullRequest } from '@/services/versioningApiService'

export type ReviewItem = { pr: PullRequest; sourceLabel: string }

const NOT_FOUND = /404|not found/i

export function DataSourceReviewFeed({
  wsId, dataSourceId, sourceLabel, onLoaded,
}: {
  wsId: string
  dataSourceId: string
  sourceLabel: string
  onLoaded: (dataSourceId: string, items: ReviewItem[], failed: boolean) => void
}) {
  const open = useDataSourcePullRequests(wsId, dataSourceId, 'open')
  const latest = useDataSourcePullRequests(wsId, dataSourceId)

  useEffect(() => {
    if (open.isPending || latest.isPending) return
    // A 404 is a data source with no versioned graph → no PRs; any other error is a failed read.
    const failed = [open.error, latest.error].some((e) => !!e && !NOT_FOUND.test(String(e.message)))
    const byId = new Map([...(latest.data ?? []), ...(open.data ?? [])].map((pr) => [pr.prId, pr]))
    onLoaded(dataSourceId, [...byId.values()].map((pr) => ({ pr, sourceLabel })), failed)
  }, [open.data, latest.data, open.error, latest.error, open.isPending, latest.isPending, dataSourceId, sourceLabel, onLoaded])

  return null
}
