import { Link } from 'react-router-dom'
import {
  Heart,
  Link2,
  Network,
  GitBranch,
  Layout,
  Table2,
  Layers,
  Globe,
  Users,
  Lock,
} from 'lucide-react'
import type { View } from '@/services/viewApiService'
import { cn } from '@/lib/utils'
import { workspaceColor } from '@/lib/workspaceColor'
import { timeAgo } from '@/lib/timeAgo'

/* ------------------------------------------------------------------ */
/*  View type icon + themed color mapping                              */
/* ------------------------------------------------------------------ */

const VIEW_TYPE_META: Record<
  string,
  { icon: React.ElementType; bg: string; border: string; text: string }
> = {
  graph: {
    icon: Network,
    bg: 'bg-indigo-500/10',
    border: 'border-indigo-500/20',
    text: 'text-indigo-500',
  },
  hierarchy: {
    icon: GitBranch,
    bg: 'bg-violet-500/10',
    border: 'border-violet-500/20',
    text: 'text-violet-500',
  },
  table: {
    icon: Table2,
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/20',
    text: 'text-emerald-500',
  },
  'layered-lineage': {
    icon: Layers,
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/20',
    text: 'text-amber-500',
  },
  reference: {
    icon: Layout,
    bg: 'bg-rose-500/10',
    border: 'border-rose-500/20',
    text: 'text-rose-500',
  },
}

const DEFAULT_TYPE_META = {
  icon: Layout,
  bg: 'bg-indigo-500/10',
  border: 'border-indigo-500/20',
  text: 'text-indigo-500',
}

const VISIBILITY_ICON: Record<string, React.ElementType> = {
  enterprise: Globe,
  workspace: Users,
  private: Lock,
}

const VIEW_TYPE_LABEL: Record<string, string> = {
  graph: 'Graph',
  hierarchy: 'Hierarchy',
  reference: 'Reference',
  table: 'Table',
  'layered-lineage': 'Lineage',
}

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface ExplorerListRowProps {
  view: View
  onToggleFavourite: () => void
  onShare: () => void
  onPreview?: () => void
  onDelete?: () => void
  healthStatus?: 'healthy' | 'warning' | 'broken' | 'stale'
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ExplorerListRow({
  view,
  onToggleFavourite,
  onShare,
}: ExplorerListRowProps) {
  const typeMeta = VIEW_TYPE_META[view.viewType] ?? DEFAULT_TYPE_META
  const TypeIcon = typeMeta.icon
  const VisIcon = VISIBILITY_ICON[view.visibility] ?? Lock
  const wsColor = workspaceColor(view.workspaceId)

  return (
    <Link to={`/views/${view.id}`} className="block group">
      <div
        className={cn(
          'grid grid-cols-[minmax(0,2fr)_140px_100px_36px_120px_60px_80px_72px] items-center gap-3',
          'rounded-xl px-3 py-2.5',
          'hover:bg-black/5 dark:hover:bg-white/5',
          'transition-colors duration-150',
        )}
      >
        {/* ── Name + colored icon container ── */}
        <div className="flex items-center gap-3 overflow-hidden">
          <div
            className={cn(
              'w-7 h-7 rounded-lg border flex items-center justify-center shrink-0',
              typeMeta.bg,
              typeMeta.border,
              typeMeta.text,
            )}
          >
            <TypeIcon className="h-3.5 w-3.5" />
          </div>
          <span className="truncate text-sm font-medium text-ink">
            {view.name}
          </span>
        </div>

        {/* ── Workspace pill ── */}
        <span
          className={cn(
            'inline-flex w-fit items-center truncate rounded-full border px-2.5 py-0.5 text-[11px] font-medium leading-none',
            wsColor.bg,
            wsColor.text,
            wsColor.border,
          )}
        >
          {view.workspaceName ?? view.workspaceId}
        </span>

        {/* ── Type label ── */}
        <span className="text-xs text-ink-muted">
          {VIEW_TYPE_LABEL[view.viewType] ?? view.viewType}
        </span>

        {/* ── Visibility icon ── */}
        <VisIcon className="h-3.5 w-3.5 text-ink-muted" />

        {/* ── Owner ── */}
        <span className="truncate text-xs text-ink-muted">
          {view.createdBy ?? '--'}
        </span>

        {/* ── Favourite count ── */}
        <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
          <Heart className="h-3 w-3" />
          {view.favouriteCount}
        </span>

        {/* ── Updated ── */}
        <span className="text-xs text-ink-muted">
          {timeAgo(view.updatedAt)}
        </span>

        {/* ── Actions ── */}
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onToggleFavourite()
            }}
            className={cn(
              'rounded-lg p-1.5 transition-colors duration-150',
              view.isFavourited
                ? 'text-red-500 hover:bg-red-500/10'
                : 'text-ink-muted hover:text-red-500 hover:bg-black/5 dark:hover:bg-white/5',
            )}
          >
            <Heart
              className="h-3.5 w-3.5"
              fill={view.isFavourited ? 'currentColor' : 'none'}
            />
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onShare()
            }}
            className="rounded-lg p-1.5 text-ink-muted transition-colors duration-150 hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
          >
            <Link2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </Link>
  )
}
