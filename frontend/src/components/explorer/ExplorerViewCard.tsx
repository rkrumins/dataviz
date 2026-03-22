/**
 * ExplorerViewCard — Premium view card optimized for 60fps interactions.
 *
 * Performance rules applied:
 * - NO transition-all (only transition specific properties)
 * - NO backdrop-blur on cards (only on singular overlays)
 * - NO gradient overlay div (use border-color shift instead)
 * - CSS-only hover (no framer-motion on individual cards)
 * - will-change-transform for GPU-accelerated lift
 */
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

// ─── View type themes ───────────────────────────────────────────
const VIEW_TYPE_META: Record<
  string,
  { icon: React.ElementType; iconBg: string; hoverBorder: string }
> = {
  graph: {
    icon: Network,
    iconBg: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-500',
    hoverBorder: 'group-hover:border-indigo-500/30',
  },
  hierarchy: {
    icon: GitBranch,
    iconBg: 'bg-violet-500/10 border-violet-500/20 text-violet-500',
    hoverBorder: 'group-hover:border-violet-500/30',
  },
  table: {
    icon: Table2,
    iconBg: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500',
    hoverBorder: 'group-hover:border-emerald-500/30',
  },
  'layered-lineage': {
    icon: Layers,
    iconBg: 'bg-amber-500/10 border-amber-500/20 text-amber-500',
    hoverBorder: 'group-hover:border-amber-500/30',
  },
  reference: {
    icon: Layout,
    iconBg: 'bg-rose-500/10 border-rose-500/20 text-rose-500',
    hoverBorder: 'group-hover:border-rose-500/30',
  },
}

const DEFAULT_META = {
  icon: Layout,
  iconBg: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-500',
  hoverBorder: 'group-hover:border-indigo-500/30',
}

const VISIBILITY_META: Record<string, { icon: React.ElementType; label: string }> = {
  enterprise: { icon: Globe, label: 'Enterprise' },
  workspace: { icon: Users, label: 'Workspace' },
  private: { icon: Lock, label: 'Private' },
}

const HEALTH_DOT: Record<string, string> = {
  warning: 'bg-amber-400',
  broken: 'bg-red-500',
  stale: 'bg-amber-400/60',
}

// ─── Props ───────────────────────────────────────────────────────
export interface ExplorerViewCardProps {
  view: View
  onToggleFavourite: () => void
  onShare: () => void
  onPreview?: () => void
  onDelete?: () => void
  healthStatus?: 'healthy' | 'warning' | 'broken' | 'stale'
}

function initials(name?: string): string {
  if (!name) return '?'
  return name.split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('')
}

// ─── Component ───────────────────────────────────────────────────
export function ExplorerViewCard({
  view,
  onToggleFavourite,
  onShare,
  healthStatus,
}: ExplorerViewCardProps) {
  const meta = VIEW_TYPE_META[view.viewType] ?? DEFAULT_META
  const TypeIcon = meta.icon
  const vis = VISIBILITY_META[view.visibility] ?? VISIBILITY_META.private
  const VisIcon = vis.icon
  const wsColor = workspaceColor(view.workspaceId)
  const tags = view.tags ?? []
  const visibleTags = tags.slice(0, 3)
  const overflowCount = tags.length - visibleTags.length
  const healthDot = healthStatus ? HEALTH_DOT[healthStatus] : null

  return (
    <Link to={`/views/${view.id}`} className="block group">
      <div
        className={cn(
          // Base card — no backdrop-blur, no gradient overlay
          'relative flex flex-col rounded-2xl border border-glass-border bg-canvas-elevated p-5',
          // GPU-accelerated hover lift — only transform + shadow + border transition
          'will-change-transform',
          'hover:-translate-y-1 hover:shadow-lg',
          'transition-[transform,box-shadow,border-color] duration-200 ease-out',
          // Themed hover border
          meta.hoverBorder,
        )}
      >
        {/* Health dot */}
        {healthDot && (
          <span className={cn('absolute right-4 top-4 h-2 w-2 rounded-full', healthDot)} />
        )}

        {/* Header: icon + title */}
        <div className="flex items-center gap-3 mb-3">
          <div className={cn('w-9 h-9 rounded-xl border flex items-center justify-center shrink-0', meta.iconBg)}>
            <TypeIcon className="h-4 w-4" />
          </div>
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink group-hover:text-accent-lineage transition-colors duration-150">
            {view.name}
          </h3>
        </div>

        {/* Badges */}
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          <span className={cn(
            'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none',
            wsColor.bg, wsColor.text, wsColor.border,
          )}>
            {view.workspaceName ?? view.workspaceId}
          </span>
          <span className="inline-flex items-center gap-1 text-[11px] text-ink-muted">
            <VisIcon className="h-3 w-3" />
            {vis.label}
          </span>
        </div>

        {/* Description */}
        {view.description && (
          <p className="line-clamp-2 text-xs leading-relaxed text-ink-muted mb-3">
            {view.description}
          </p>
        )}

        {/* Tags */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            {visibleTags.map(tag => (
              <span key={tag} className="rounded-full bg-black/[0.04] dark:bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium text-ink-muted">
                {tag}
              </span>
            ))}
            {overflowCount > 0 && (
              <span className="rounded-full bg-black/[0.04] dark:bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium text-ink-muted">
                +{overflowCount}
              </span>
            )}
          </div>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Footer */}
        <div className="flex items-center gap-2 border-t border-glass-border/50 pt-3 mt-1">
          {view.createdBy && (
            <div className={cn('w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0', meta.iconBg)} title={view.createdBy}>
              {initials(view.createdBy)}
            </div>
          )}
          <span className="inline-flex items-center gap-1 text-[11px] text-ink-muted">
            <Heart className="h-3 w-3" /> {view.favouriteCount}
          </span>
          <span className="text-[11px] text-ink-muted">{timeAgo(view.updatedAt)}</span>

          {/* Actions */}
          <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
            <button
              type="button"
              onClick={e => { e.preventDefault(); e.stopPropagation(); onToggleFavourite() }}
              className={cn(
                'rounded-lg p-1.5 transition-colors duration-150',
                view.isFavourited ? 'text-red-500' : 'text-ink-muted hover:text-red-500',
              )}
            >
              <Heart className="h-3.5 w-3.5" fill={view.isFavourited ? 'currentColor' : 'none'} />
            </button>
            <button
              type="button"
              onClick={e => { e.preventDefault(); e.stopPropagation(); onShare() }}
              className="rounded-lg p-1.5 text-ink-muted hover:text-ink transition-colors duration-150"
            >
              <Link2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </Link>
  )
}
