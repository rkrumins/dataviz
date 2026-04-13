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
  Box,
  ExternalLink,
  Pencil,
  Check,
  Trash2,
  RotateCcw,
} from 'lucide-react'
import type { View } from '@/services/viewApiService'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { ViewScopeBadge } from '@/components/explorer/ViewScopeBadge'
import { CreatorHoverCard } from '@/components/explorer/CreatorHoverCard'
import { HeartBurstButton } from '@/components/explorer/HeartBurstButton'

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
  onEdit?: () => void
  editDisabled?: boolean
  onDelete?: () => void
  onRestore?: () => void
  onPermanentDelete?: () => void
  healthStatus?: 'healthy' | 'warning' | 'broken' | 'stale'
  isSelected?: boolean
  onToggleSelect?: () => void
  /** Visual density — controls vertical padding. */
  density?: 'compact' | 'comfortable' | 'spacious'
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ExplorerListRow({
  view,
  onToggleFavourite,
  onShare,
  onPreview,
  onEdit,
  editDisabled,
  onDelete,
  onRestore,
  onPermanentDelete,
  isSelected,
  onToggleSelect,
  density = 'comfortable',
}: ExplorerListRowProps) {
  const typeMeta = VIEW_TYPE_META[view.viewType] ?? DEFAULT_TYPE_META
  const TypeIcon = typeMeta.icon
  const VisIcon = VISIBILITY_ICON[view.visibility] ?? Lock
  const isDeleted = !!view.deletedAt

  // Density → row padding. Comfortable is the visual default from before
  // the toggle existed, so existing screenshots stay unchanged at default.
  const densityPaddingClass =
    density === 'compact' ? 'py-1.5'
    : density === 'spacious' ? 'py-4'
    : 'py-2.5'

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
            ? 'grid-cols-[28px_minmax(0,2fr)_160px_90px_36px_110px_70px_80px_140px]'
            : 'grid-cols-[minmax(0,2fr)_160px_90px_36px_110px_70px_80px_140px]',
          'rounded-xl px-3',
          densityPaddingClass,
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

        {/* ── Workspace + Data source pills ── */}
        <div className="inline-flex items-center gap-1.5">
          <ViewScopeBadge
            workspaceId={view.workspaceId}
            workspaceName={view.workspaceName}
            dataSourceId={view.dataSourceId}
            dataSourceName={view.dataSourceName}
          />
        </div>

        {/* ── Type label ── */}
        <span className="text-xs text-ink-muted">
          {typeMeta.label}
        </span>

        {/* ── Visibility icon ── */}
        <VisIcon className="h-3.5 w-3.5 text-ink-muted" />

        {/* ── Owner ──
             Prefer the server-resolved display name; fall back to the raw
             user id (legacy rows). The CreatorHoverCard shows full name +
             email on hover so power users can disambiguate without taking
             a round-trip to the view detail drawer. */}
        {(view.createdByName || view.createdBy) ? (
          <CreatorHoverCard
            userId={view.createdBy ?? null}
            displayName={view.createdByName ?? null}
            email={view.createdByEmail ?? null}
          >
            <span className="truncate text-xs text-ink-muted cursor-default" tabIndex={0}>
              {view.createdByName ?? view.createdBy}
            </span>
          </CreatorHoverCard>
        ) : (
          <span className="truncate text-xs text-ink-muted">—</span>
        )}

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
        <div className="flex items-center justify-end gap-0.5">
          {isDeleted ? (
            <>
              {onRestore && (
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); onRestore() }}
                  className="rounded-lg p-1.5 text-ink-muted hover:text-emerald-500 hover:bg-emerald-500/10 transition-colors duration-150"
                  title="Restore view"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              )}
              {onPermanentDelete && (
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); onPermanentDelete() }}
                  className="rounded-lg p-1.5 text-ink-muted hover:text-red-500 hover:bg-red-500/10 transition-colors duration-150"
                  title="Permanently delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </>
          ) : (
            <>
              <Link
                to={`/views/${view.id}`}
                onClick={e => e.stopPropagation()}
                className="rounded-lg p-1.5 text-ink-muted transition-colors duration-150 hover:text-accent-lineage hover:bg-black/5 dark:hover:bg-white/5"
                title="Open view"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
              {onEdit && (
                editDisabled ? (
                  <span
                    className="relative rounded-lg p-1.5 text-ink-muted/40 cursor-not-allowed group/edit"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-max max-w-[200px] rounded-lg bg-slate-900 dark:bg-slate-700 px-3 py-2 text-[11px] text-white leading-snug opacity-0 group-hover/edit:opacity-100 transition-opacity duration-150 z-50 shadow-lg">
                      Switch to this view's workspace to edit
                    </span>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); onEdit() }}
                    className="rounded-lg p-1.5 text-ink-muted hover:text-accent-lineage hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150"
                    title="Edit view"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )
              )}
              <HeartBurstButton
                favourited={view.isFavourited}
                onToggle={onToggleFavourite}
                size="sm"
              />
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onShare()
                }}
                className="rounded-lg p-1.5 text-ink-muted transition-colors duration-150 hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
                title="Copy share link"
              >
                <Link2 className="h-3.5 w-3.5" />
              </button>
              {onDelete && (
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); onDelete() }}
                  className="rounded-lg p-1.5 text-ink-muted hover:text-red-500 hover:bg-red-500/10 transition-colors duration-150"
                  title="Delete view"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
