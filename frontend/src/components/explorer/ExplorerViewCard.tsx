/**
 * ExplorerViewCard — Aligned, consistent card layout.
 *
 * Every card renders the same vertical sections at the same heights:
 *   Header → Badges → Description → Preview → Tags → Synced → Footer
 * Empty sections still occupy their space for grid alignment.
 *
 * Actions (open, favourite, share) float top-right on hover.
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
  Box,
  ExternalLink,
  RefreshCw,
} from 'lucide-react'
import type { View } from '@/services/viewApiService'
import { cn } from '@/lib/utils'
import { workspaceColor } from '@/lib/workspaceColor'
import { timeAgo } from '@/lib/timeAgo'

// ─── View type themes ───────────────────────────────────────────
const VIEW_TYPE_META: Record<
  string,
  { icon: React.ElementType; label: string; iconBg: string; hoverBorder: string }
> = {
  graph: {
    icon: Network,
    label: 'Graph',
    iconBg: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-500',
    hoverBorder: 'group-hover:border-indigo-500/30',
  },
  hierarchy: {
    icon: GitBranch,
    label: 'Hierarchy',
    iconBg: 'bg-violet-500/10 border-violet-500/20 text-violet-500',
    hoverBorder: 'group-hover:border-violet-500/30',
  },
  table: {
    icon: Table2,
    label: 'Table',
    iconBg: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500',
    hoverBorder: 'group-hover:border-emerald-500/30',
  },
  'layered-lineage': {
    icon: Layers,
    label: 'Lineage',
    iconBg: 'bg-amber-500/10 border-amber-500/20 text-amber-500',
    hoverBorder: 'group-hover:border-amber-500/30',
  },
  reference: {
    icon: Layout,
    label: 'Reference',
    iconBg: 'bg-rose-500/10 border-rose-500/20 text-rose-500',
    hoverBorder: 'group-hover:border-rose-500/30',
  },
}

const DEFAULT_META = {
  icon: Layout,
  label: 'View',
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

// ─── Mini preview illustrations ─────────────────────────────────
function MiniPreview({ viewType }: { viewType: string }) {
  if (viewType === 'hierarchy') {
    return (
      <svg viewBox="0 0 120 48" className="w-full h-full text-violet-500/20">
        <circle cx="60" cy="8" r="4" fill="currentColor" />
        <line x1="60" y1="12" x2="30" y2="28" stroke="currentColor" strokeWidth="1.5" />
        <line x1="60" y1="12" x2="60" y2="28" stroke="currentColor" strokeWidth="1.5" />
        <line x1="60" y1="12" x2="90" y2="28" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="30" cy="32" r="3.5" fill="currentColor" />
        <circle cx="60" cy="32" r="3.5" fill="currentColor" />
        <circle cx="90" cy="32" r="3.5" fill="currentColor" />
        <line x1="30" y1="35.5" x2="18" y2="44" stroke="currentColor" strokeWidth="1" />
        <line x1="30" y1="35.5" x2="42" y2="44" stroke="currentColor" strokeWidth="1" />
        <circle cx="18" cy="44" r="2.5" fill="currentColor" opacity="0.6" />
        <circle cx="42" cy="44" r="2.5" fill="currentColor" opacity="0.6" />
      </svg>
    )
  }
  if (viewType === 'reference') {
    return (
      <svg viewBox="0 0 120 48" className="w-full h-full text-rose-500/20">
        <rect x="4" y="4" width="24" height="16" rx="2" fill="currentColor" />
        <rect x="32" y="4" width="24" height="16" rx="2" fill="currentColor" opacity="0.7" />
        <rect x="60" y="4" width="24" height="16" rx="2" fill="currentColor" opacity="0.5" />
        <rect x="88" y="4" width="24" height="16" rx="2" fill="currentColor" opacity="0.3" />
        <rect x="4" y="26" width="24" height="16" rx="2" fill="currentColor" opacity="0.7" />
        <rect x="32" y="26" width="24" height="16" rx="2" fill="currentColor" opacity="0.5" />
        <rect x="60" y="26" width="24" height="16" rx="2" fill="currentColor" opacity="0.3" />
        <line x1="8" y1="10" x2="24" y2="10" stroke="white" strokeWidth="1" opacity="0.5" />
        <line x1="8" y1="14" x2="20" y2="14" stroke="white" strokeWidth="1" opacity="0.3" />
        <line x1="36" y1="10" x2="52" y2="10" stroke="white" strokeWidth="1" opacity="0.5" />
        <line x1="36" y1="14" x2="48" y2="14" stroke="white" strokeWidth="1" opacity="0.3" />
      </svg>
    )
  }
  return null
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
  onPreview,
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
  const hasPreview = view.viewType === 'hierarchy' || view.viewType === 'reference'
  const showContextModel = view.contextModelName
    && view.contextModelName.toLowerCase() !== view.name.toLowerCase()

  return (
    <div
      className="block group h-full cursor-pointer"
      onClick={() => onPreview?.()}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter') onPreview?.() }}
    >
      <div
        className={cn(
          'relative flex flex-col h-full rounded-2xl border border-glass-border bg-canvas-elevated p-5',
          'will-change-transform',
          'hover:-translate-y-1 hover:shadow-lg',
          'hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
          'transition-[transform,box-shadow,border-color,background-color] duration-200 ease-out',
          meta.hoverBorder,
        )}
      >
        {/* ── Top-right actions (hover reveal) ── */}
        <div className="absolute top-3 right-3 flex items-center gap-0.5 rounded-lg bg-canvas-elevated/90 border border-glass-border/50 p-0.5 shadow-sm invisible group-hover:visible z-10">
          <Link
            to={`/views/${view.id}`}
            onClick={e => e.stopPropagation()}
            className="rounded-lg p-1.5 text-ink-muted hover:text-accent-lineage hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors duration-150"
            title="Open view"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onToggleFavourite() }}
            className={cn(
              'rounded-lg p-1.5 transition-colors duration-150',
              view.isFavourited
                ? 'text-red-500 hover:bg-red-500/10'
                : 'text-ink-muted hover:text-red-500 hover:bg-black/[0.06] dark:hover:bg-white/[0.08]',
            )}
          >
            <Heart className="h-3.5 w-3.5" fill={view.isFavourited ? 'currentColor' : 'none'} />
          </button>
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onShare() }}
            className="rounded-lg p-1.5 text-ink-muted hover:text-ink hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors duration-150"
          >
            <Link2 className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Health dot */}
        {healthDot && (
          <span className={cn('absolute right-4 top-4 h-2 w-2 rounded-full group-hover:hidden', healthDot)} />
        )}

        {/* ── 1. Header: icon + type + name ── */}
        <div className="flex items-center gap-3 mb-3 pr-6">
          <div className={cn('w-10 h-10 rounded-xl border flex items-center justify-center shrink-0', meta.iconBg)}>
            <TypeIcon className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              {meta.label}
            </span>
            <h3 className="truncate text-sm font-bold text-ink group-hover:text-accent-lineage transition-colors duration-150 leading-tight">
              {view.name}
            </h3>
          </div>
        </div>

        {/* ── 2. Badges: workspace + visibility + semantic layer ── */}
        <div className="flex flex-wrap items-center gap-1.5 mb-3 min-h-[22px]">
          <span className={cn(
            'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none',
            wsColor.bg, wsColor.text, wsColor.border,
          )}>
            {view.workspaceName ?? view.workspaceId}
          </span>
          <span className="inline-flex items-center gap-1 text-[10px] text-ink-muted font-medium">
            <VisIcon className="h-2.5 w-2.5" />
            {vis.label}
          </span>
          {showContextModel && (
            <span className="inline-flex items-center gap-1 rounded-full border border-cyan-500/20 bg-cyan-500/8 px-2 py-0.5 text-[10px] font-medium text-cyan-600 dark:text-cyan-400 leading-none truncate max-w-[140px]">
              <Box className="h-2.5 w-2.5 shrink-0" />
              {view.contextModelName}
            </span>
          )}
        </div>

        {/* ── 4. Description (fixed 2-line height) ── */}
        <div className="mb-3 min-h-[2.5rem]">
          {view.description ? (
            <p className="line-clamp-2 text-xs leading-relaxed text-ink-muted">
              {view.description}
            </p>
          ) : (
            <p className="text-xs text-ink-muted/30 italic">No description</p>
          )}
        </div>

        {/* ── 5. Preview area (fixed height for all cards) ── */}
        <div className="mb-3 h-[3.75rem]">
          {hasPreview ? (
            <div className="rounded-lg border border-glass-border/50 bg-black/[0.015] dark:bg-white/[0.015] px-2 py-1 overflow-hidden h-full">
              <MiniPreview viewType={view.viewType} />
            </div>
          ) : (
            <div className="h-full" />
          )}
        </div>

        {/* ── 6. Tags (fixed height) ── */}
        <div className="mb-3 min-h-[20px]">
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
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
        </div>

        {/* ── 7. Last synced ── */}
        <div className="flex items-center gap-1 mb-2">
          <RefreshCw className="h-2.5 w-2.5 text-ink-muted/50" />
          <span className="text-[10px] text-ink-muted/50">
            Synced {timeAgo(view.updatedAt)}
          </span>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* ── 8. Footer (clean — just creator + stats) ── */}
        <div className="flex items-center gap-2 border-t border-glass-border/50 pt-3 mt-1">
          {view.createdBy && (
            <div className="flex items-center gap-1.5 min-w-0">
              <div
                className={cn('w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold shrink-0', meta.iconBg)}
                title={view.createdBy}
              >
                {initials(view.createdBy)}
              </div>
              <span className="text-[11px] text-ink-muted truncate max-w-[70px]">
                {view.createdBy}
              </span>
            </div>
          )}

          <span className="inline-flex items-center gap-1 text-[11px] text-ink-muted ml-auto">
            <Heart className="h-3 w-3" fill={view.isFavourited ? 'currentColor' : 'none'} />
            {view.favouriteCount}
          </span>

          <span className="text-[10px] text-ink-muted/70">{timeAgo(view.updatedAt)}</span>
        </div>
      </div>
    </div>
  )
}
