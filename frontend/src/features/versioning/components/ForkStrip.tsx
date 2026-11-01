/**
 * ForkStrip — on a fork's own pages, its Versioning tab and the canvas of its views: "Fork of
 * <parent>" (a link to that data source), how far the fork is from it, and its two actions, Update
 * from parent (publishers) and Propose to parent. While forks are off it says so and offers neither:
 * the fork still reads.
 *
 * Renders nothing on a data source that is no fork, and reads nothing to find that out (see
 * `isForkDataSourceId`). For a fork, `forkOf` on its data source says what it was forked from — read
 * from the workspace's data sources with forks included, which its other lists leave out — and its
 * entry in its parent's Forks list says how far it is.
 */
import { Link } from 'react-router-dom'
import { GitFork } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePermission } from '@/store/auth'
import { useFeature } from '@/store/features'
import { useDataSourcesWithForks, useForks } from '../hooks/useVersioning'
import { isForkDataSourceId } from '../model/forks'
import { ForkDistance, ForksOffNote, UpdateRecommendedHint } from './ForkStatusBits'
import { ProposeToParentButton } from './ProposeToParentButton'
import { UpdateFromParentButton } from './UpdateFromParentButton'

interface ForkStripProps {
  wsId: string
  dataSourceId: string
  /** `tab`: a card at the top of the Versioning tab; `bar`: a band above the canvas. */
  variant: 'tab' | 'bar'
}

export function ForkStrip(props: ForkStripProps) {
  return isForkDataSourceId(props.dataSourceId) ? <Strip {...props} /> : null
}

function Strip({ wsId, dataSourceId, variant }: ForkStripProps) {
  const forksOn = useFeature('forksEnabled')
  const canPublish = usePermission('workspace:datasource:publish', wsId)
  const sources = useDataSourcesWithForks(wsId).data
  const forkOf = sources?.find((d) => d.id === dataSourceId)?.forkOf
  const parent = forkOf ? sources?.find((d) => d.id === forkOf.dataSourceId) : undefined
  const fork = useForks(wsId, forkOf?.graphId).data?.find((f) => f.dataSourceId === dataSourceId)
  if (!forkOf) return null

  return (
    <div className={cn(
      'flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm min-w-0',
      variant === 'bar'
        ? 'px-3 py-1.5 border-b border-indigo-500/20 bg-indigo-500/[0.06] shrink-0'
        : 'rounded-xl border border-indigo-500/20 bg-indigo-500/[0.05] px-4 py-3',
    )}>
      <span className="inline-flex items-center gap-1.5 text-ink min-w-0">
        <GitFork className="w-4 h-4 text-indigo-500 shrink-0" />
        <span className="truncate">
          Fork of{' '}
          <Link to={`/workspaces/${wsId}?ds=${encodeURIComponent(forkOf.dataSourceId)}&dstab=versioning`}
            className="font-medium text-accent-lineage hover:underline">
            {parent?.label || 'its parent'}
          </Link>
        </span>
      </span>
      {fork && <ForkDistance fork={fork} className="text-[11px] text-ink-muted" />}
      {fork && forksOn && <UpdateRecommendedHint fork={fork} className="basis-full order-last" />}
      <div className="flex-1" />
      {forksOn ? fork && (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {canPublish && <UpdateFromParentButton wsId={wsId} forkGraphId={fork.graphId} />}
          <ProposeToParentButton wsId={wsId} forkGraphId={fork.graphId} parentDataSourceId={forkOf.dataSourceId}
            behind={fork.behind ?? 0} />
        </span>
      ) : <ForksOffNote />}
    </div>
  )
}
