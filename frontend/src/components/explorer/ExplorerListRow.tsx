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
  Database,
  Box,
  ExternalLink,
  Check,
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
  { icon: React.ElementType; label: string; bg: string; border: string; text: string }
> = {
  graph: {
    icon: Network,
    label: 'Graph',
    bg: 'bg-indigo-500/10',
    border: 'border-indigo-500/20',
    text: 'text-indigo-500',
  },
  hierarchy: {
    icon: GitBranch,
    label: 'Hierarchy',
    bg: 'bg-violet-500/10',
    border: 'border-violet-500/20',
    text: 'text-violet-500',
  },
  table: {
    icon: Table2,
    label: 'Table',
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/20',
    text: 'text-emerald-500',
  },
  'layered-lineage': {
    icon: Layers,
    label: 'Lineage',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/20',
    text: 'text-amber-500',
  },
  reference: {
    icon: Layout,
    label: 'Reference',
    bg: 'bg-rose-500/10',
    border: 'border-rose-500/20',
    text: 'text-rose-500',
  },
}

const DEFAULT_TYPE_META = {
  icon: Layout,
  label: 'View',
  bg: 'bg-indigo-500/10',
  border: 'border-indigo-500/20',
  text: 'text-indigo-500',
}

const VISIBILITY_ICON: Record<string, React.ElementType> = {
  enterprise: Globe,
  workspace: Users,
  private: Lock,
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
  isSelected?: boolean
  onToggleSelect?: () => void
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ExplorerListRow({
  view,
  onToggleFavourite,
  onShare,
  onPreview,
  isSelected,
  onToggleSelect,
}: ExplorerListRowProps) {
  const typeMeta = VIEW_TYPE_META[view.viewType] ?? DEFAULT_TYPE_META
  const TypeIcon = typeMeta.icon
  const VisIcon = VISIBILITY_ICON[view.visibility] ?? Lock
  const wsColor = workspaceColor(view.workspaceId)

  return (
    <div
      className="block group cursor-pointer"
      onClick={() => onPreview?.()}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter') onPreview?.() }}
    >
      <div
        className={cn(
          'grid items-center gap-3',
          onToggleSelect
            ? 'grid-cols-[28px_minmax(0,2fr)_140px_100px_36px_100px_120px_60px_80px_72px]'
            : 'grid-cols-[minmax(0,2fr)_140px_100px_36px_100px_120px_60px_80px_72px]',
          'rounded-xl px-3 py-2.5',
          'hover:bg-black/5 dark:hover:bg-white/5',
          isSelected && 'bg-accent-lineage/[0.04]',
          'transition-colors duration-150',
        )}
      >
        {/* ── Checkbox ── */}
        {onToggleSelect && (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onToggleSelect() }}
            className={cn(
              'w-5 h-5 rounded-md border flex items-center justify-center transition-all duration-150',
              isSelected
                ? 'bg-accent-lineage border-accent-lineage text-white'
                : 'border-glass-border text-transparent hover:border-accent-lineage/50',
            )}
          >
            <Check className="h-3 w-3" strokeWidth={3} />
          </button>
        )}

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
          <div className="min-w-0">
            <span className="truncate text-sm font-medium text-ink block">
              {view.name}
            </span>
            {view.contextModelName && (
              <span className="flex items-center gap-1 text-[10px] text-ink-muted truncate">
                <Box className="h-2.5 w-2.5 shrink-0" />
                {view.contextModelName}
              </span>
            )}
          </div>
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
          {typeMeta.label}
        </span>

        {/* ── Visibility icon ── */}
        <VisIcon className="h-3.5 w-3.5 text-ink-muted" />

        {/* ── Data source ── */}
        <span className="inline-flex items-center gap-1 text-[10px] text-ink-muted truncate">
          {view.dataSourceId ? (
            <>
              <Database className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{view.dataSourceId}</span>
            </>
          ) : (
            '--'
          )}
        </span>

        {/* ── Owner ── */}
        <span className="truncate text-xs text-ink-muted">
          {view.createdBy ?? '--'}
        </span>

        {/* ── Favourite count ── */}
        <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
          <Heart className="h-3 w-3" fill={view.isFavourited ? 'currentColor' : 'none'} />
          {view.favouriteCount}
        </span>

        {/* ── Updated ── */}
        <span className="text-xs text-ink-muted">
          {timeAgo(view.updatedAt)}
        </span>

        {/* ── Actions ── */}
        <div className="flex items-center gap-0.5">
          <Link
            to={`/views/${view.id}`}
            onClick={e => e.stopPropagation()}
            className="rounded-lg p-1.5 text-ink-muted transition-colors duration-150 hover:text-accent-lineage hover:bg-black/5 dark:hover:bg-white/5"
            title="Open view"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
          <button
            type="button"
            onClick={(e) => {
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
              e.stopPropagation()
              onShare()
            }}
            className="rounded-lg p-1.5 text-ink-muted transition-colors duration-150 hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
          >
            <Link2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
