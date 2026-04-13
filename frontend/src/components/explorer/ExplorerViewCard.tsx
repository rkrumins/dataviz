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
  RefreshCw,
  AlertTriangle,
  Check,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import type { View } from '@/services/viewApiService'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { ViewCardOverflowMenu } from '@/components/explorer/ViewCardOverflowMenu'
import { ViewScopeBadge } from '@/components/explorer/ViewScopeBadge'
import { CreatorHoverCard } from '@/components/explorer/CreatorHoverCard'
import { HeartBurstButton } from '@/components/explorer/HeartBurstButton'

// ─── View type themes ───────────────────────────────────────────
// ``gradient`` is a subtle whole-card tint keyed to the view type so
// scanning a grid of mixed types stays effortless. It's very light —
// 3-4% opacity — so the card still reads as neutral up close but the
// viewport as a whole becomes colour-coded at a glance.
const VIEW_TYPE_META: Record<
  string,
  {
    icon: React.ElementType
    label: string
    iconBg: string
    hoverBorder: string
    gradient: string
  }
> = {
  graph: {
    icon: Network,
    label: 'Graph',
    iconBg: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-500',
    hoverBorder: 'group-hover:border-indigo-500/30',
    gradient: 'bg-gradient-to-br from-indigo-500/[0.04] via-transparent to-transparent',
  },
  hierarchy: {
    icon: GitBranch,
    label: 'Hierarchy',
    iconBg: 'bg-violet-500/10 border-violet-500/20 text-violet-500',
    hoverBorder: 'group-hover:border-violet-500/30',
    gradient: 'bg-gradient-to-br from-violet-500/[0.04] via-transparent to-transparent',
  },
  table: {
    icon: Table2,
    label: 'Table',
    iconBg: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500',
    hoverBorder: 'group-hover:border-emerald-500/30',
    gradient: 'bg-gradient-to-br from-emerald-500/[0.04] via-transparent to-transparent',
  },
  'layered-lineage': {
    icon: Layers,
    label: 'Lineage',
    iconBg: 'bg-amber-500/10 border-amber-500/20 text-amber-500',
    hoverBorder: 'group-hover:border-amber-500/30',
    gradient: 'bg-gradient-to-br from-amber-500/[0.04] via-transparent to-transparent',
  },
  reference: {
    icon: Layout,
    label: 'Reference',
    iconBg: 'bg-rose-500/10 border-rose-500/20 text-rose-500',
    hoverBorder: 'group-hover:border-rose-500/30',
    gradient: 'bg-gradient-to-br from-rose-500/[0.04] via-transparent to-transparent',
  },
}

const DEFAULT_META = {
  icon: Layout,
  label: 'View',
  iconBg: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-500',
  hoverBorder: 'group-hover:border-indigo-500/30',
  gradient: 'bg-gradient-to-br from-indigo-500/[0.04] via-transparent to-transparent',
}

// Deterministic tag colors from a curated palette
const TAG_COLORS = [
  { bg: 'bg-blue-500/10', text: 'text-blue-600 dark:text-blue-400', border: 'border-blue-500/20' },
  { bg: 'bg-violet-500/10', text: 'text-violet-600 dark:text-violet-400', border: 'border-violet-500/20' },
  { bg: 'bg-emerald-500/10', text: 'text-emerald-600 dark:text-emerald-400', border: 'border-emerald-500/20' },
  { bg: 'bg-amber-500/10', text: 'text-amber-600 dark:text-amber-400', border: 'border-amber-500/20' },
  { bg: 'bg-rose-500/10', text: 'text-rose-600 dark:text-rose-400', border: 'border-rose-500/20' },
  { bg: 'bg-cyan-500/10', text: 'text-cyan-600 dark:text-cyan-400', border: 'border-cyan-500/20' },
  { bg: 'bg-indigo-500/10', text: 'text-indigo-600 dark:text-indigo-400', border: 'border-indigo-500/20' },
  { bg: 'bg-teal-500/10', text: 'text-teal-600 dark:text-teal-400', border: 'border-teal-500/20' },
]

function tagColor(tag: string) {
  let hash = 0
  for (let i = 0; i < tag.length; i++) hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length]
}

const VISIBILITY_META: Record<string, { icon: React.ElementType; label: string }> = {
  enterprise: { icon: Globe, label: 'Enterprise' },
  workspace: { icon: Users, label: 'Workspace' },
  private: { icon: Lock, label: 'Private' },
}

const HEALTH_INDICATOR: Record<string, { color: string; tooltip: string }> = {
  warning: { color: 'text-amber-500', tooltip: 'Data source may have changed' },
  broken: { color: 'text-red-500', tooltip: 'Data source has been deleted' },
  stale: { color: 'text-amber-400/70', tooltip: 'View has not been updated recently' },
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
  onEdit?: () => void
  /** When true, the edit button renders disabled with a tooltip. */
  editDisabled?: boolean
  onDelete?: () => void
  onRestore?: () => void
  onPermanentDelete?: () => void
  /** When provided, tag chips become clickable → toggle the tag filter. */
  onTagClick?: (tag: string) => void
  healthStatus?: 'healthy' | 'warning' | 'broken' | 'stale'
  isSelected?: boolean
  onToggleSelect?: () => void
  /** Visual density — collapses padding, preview, and ancillary sections. */
  density?: 'compact' | 'comfortable' | 'spacious'
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
  onEdit,
  editDisabled,
  onDelete,
  onRestore,
  onPermanentDelete,
  onTagClick,
  healthStatus,
  isSelected,
  onToggleSelect,
  density = 'comfortable',
}: ExplorerViewCardProps) {
  // Density-derived classes. Compact noticeably reduces vertical rhythm
  // (padding, section margins, suppressed mini preview) so a dense grid
  // actually looks dense. Spacious does the inverse.
  const compact = density === 'compact'
  const spacious = density === 'spacious'
  const cardPadding = compact ? 'p-3.5' : spacious ? 'p-6' : 'p-5'
  const sectionGap = compact ? 'mb-2' : spacious ? 'mb-4' : 'mb-3'
  const typeBadgeSize = compact ? 'w-8 h-8' : 'w-10 h-10'
  const typeBadgeRound = compact ? 'rounded-lg' : 'rounded-xl'
  // In compact mode, suppress the decorative mini preview and description
  // line so each card collapses to header + badges + footer.
  const showPreview = !compact
  const showDescription = !compact
  const showTags = !compact
  const isDeleted = !!view.deletedAt
  const meta = VIEW_TYPE_META[view.viewType] ?? DEFAULT_META
  const TypeIcon = meta.icon
  const vis = VISIBILITY_META[view.visibility] ?? VISIBILITY_META.private
  const VisIcon = vis.icon
  const tags = view.tags ?? []
  const visibleTags = tags.slice(0, 3)
  const overflowCount = tags.length - visibleTags.length
  const healthInfo = healthStatus ? HEALTH_INDICATOR[healthStatus] : null
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
          'relative flex flex-col h-full rounded-2xl border bg-canvas-elevated overflow-hidden',
          cardPadding,
          'will-change-transform',
          // Deeper lift + stronger, colored shadow for a more tactile hover.
          'hover:-translate-y-1.5 hover:shadow-xl hover:shadow-black/5 dark:hover:shadow-black/30',
          'hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
          'transition-[transform,box-shadow,border-color,background-color] duration-200 ease-out',
          isSelected
            ? 'border-accent-lineage shadow-[0_0_0_1px_rgba(var(--accent-lineage-rgb,99,102,241),0.3)]'
            : isDeleted
              ? 'border-red-500/20'
              : view.isPinned
                ? 'border-accent-lineage/40 shadow-md shadow-accent-lineage/5'
                : 'border-glass-border',
          !isDeleted && meta.hoverBorder,
          isDeleted && 'opacity-60',
        )}
      >
        {/* Subtle view-type gradient wash — sits behind content so it
            doesn't interfere with text contrast or interactive children. */}
        {!isDeleted && (
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-0 rounded-2xl',
              meta.gradient,
            )}
          />
        )}

        {/* Pinned ribbon — compact accent badge in the top-right corner. */}
        {view.isPinned && !isDeleted && (
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute top-0 right-5 z-10',
              'inline-flex items-center gap-1 rounded-b-md px-1.5 py-0.5',
              'bg-accent-lineage text-white text-[9px] font-semibold uppercase tracking-wider',
              'shadow-sm',
            )}
          >
            Pinned
          </div>
        )}
        {/* ── Top-left checkbox ── */}
        {onToggleSelect && (
          <div
            className={cn(
              'absolute top-3 left-3 z-10',
              !isSelected && 'opacity-0 group-hover:opacity-100',
            )}
          >
            <button
              type="button"
              onClick={e => { e.stopPropagation(); onToggleSelect() }}
              className={cn(
                'w-5 h-5 rounded-md border-2 flex items-center justify-center',
                'transition-colors duration-150',
                isSelected
                  ? 'bg-accent-lineage border-accent-lineage text-white'
                  : 'border-ink-muted/40 bg-canvas-elevated hover:border-accent-lineage',
              )}
            >
              {isSelected && <Check className="h-3 w-3" strokeWidth={3} />}
            </button>
          </div>
        )}

        {/* ── Top-right actions (hover reveal) ── */}
        <div className="absolute top-3 right-3 flex items-center gap-0.5 rounded-lg bg-canvas-elevated/90 border border-glass-border/50 p-0.5 shadow-sm invisible group-hover:visible z-10">
          {isDeleted ? (
            <>
              {onRestore && (
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); onRestore() }}
                  className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 transition-colors duration-150 flex items-center gap-1.5"
                  title="Restore view"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Restore
                </button>
              )}
              {onPermanentDelete && (
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); onPermanentDelete() }}
                  className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red-500 hover:bg-red-500/10 transition-colors duration-150 flex items-center gap-1.5"
                  title="Permanently delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </button>
              )}
            </>
          ) : (
            <>
          <Link
            to={`/views/${view.id}`}
            onClick={e => e.stopPropagation()}
            className="rounded-lg p-1.5 text-ink-muted hover:text-accent-lineage hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors duration-150"
            title="Open view"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
          {onEdit && (
            editDisabled ? (
              <span
                className="relative rounded-lg p-1.5 text-ink-muted/40 cursor-not-allowed group/edit"
                title="Switch to this view's workspace to edit"
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
                className="rounded-lg p-1.5 text-ink-muted hover:text-accent-lineage hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors duration-150"
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
          <ViewCardOverflowMenu
            viewId={view.id}
            viewName={view.name}
            visibility={view.visibility}
            onEdit={onEdit}
            editDisabled={editDisabled}
            onDelete={() => onDelete?.()}
            onShare={onShare}
          />
            </>
          )}
        </div>

        {/* ── 1. Header: icon + type + name ── */}
        <div className={cn('flex items-center gap-3 pr-6', sectionGap)}>
          <div className={cn('border flex items-center justify-center shrink-0', typeBadgeSize, typeBadgeRound, meta.iconBg)}>
            <TypeIcon className={cn(compact ? 'h-4 w-4' : 'h-[18px] w-[18px]')} />
          </div>
          <div className="min-w-0 flex-1">
            {!compact && (
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                {meta.label}
              </span>
            )}
            <h3 className="truncate text-sm font-bold text-ink group-hover:text-accent-lineage transition-colors duration-150 leading-tight">
              {view.name}
            </h3>
          </div>
        </div>

        {/* ── 2. Badges: workspace + visibility + semantic layer ── */}
        <div className={cn('flex flex-wrap items-center gap-1.5 min-h-[22px]', sectionGap)}>
          <ViewScopeBadge
            workspaceId={view.workspaceId}
            workspaceName={view.workspaceName}
            dataSourceId={view.dataSourceId}
            dataSourceName={view.dataSourceName}
          />
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
          {healthInfo && (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none border',
                healthStatus === 'broken'
                  ? 'border-red-500/20 bg-red-500/8 text-red-500'
                  : 'border-amber-500/20 bg-amber-500/8 text-amber-600 dark:text-amber-400',
              )}
              title={healthInfo.tooltip}
            >
              <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
              {healthStatus === 'broken' ? 'Source deleted' : healthStatus === 'warning' ? 'Warning' : 'Stale'}
            </span>
          )}
          {isDeleted && (
            <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none border border-red-500/20 bg-red-500/8 text-red-500">
              <Trash2 className="h-2.5 w-2.5 shrink-0" />
              Deleted
            </span>
          )}
        </div>

        {/* ── 4. Description (fixed 2-line height) — hidden in compact ── */}
        {showDescription && (
          <div className={cn('min-h-[2.5rem]', sectionGap)}>
            {view.description ? (
              <p className="line-clamp-2 text-xs leading-relaxed text-ink-muted">
                {view.description}
              </p>
            ) : (
              <div />
            )}
          </div>
        )}

        {/* ── 5. Preview area — hidden in compact density ── */}
        {showPreview && (
          <div className={cn('h-[3.75rem]', sectionGap)}>
            {hasPreview ? (
              <div className="rounded-lg border border-glass-border/50 bg-black/[0.015] dark:bg-white/[0.015] px-2 py-1 overflow-hidden h-full">
                <MiniPreview viewType={view.viewType} />
              </div>
            ) : (
              <div className="h-full" />
            )}
          </div>
        )}

        {/* ── 6. Tags (fixed height) — hidden in compact density ── */}
        {showTags && (
        <div className={cn('min-h-[20px]', sectionGap)}>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {visibleTags.map(tag => {
                const tc = tagColor(tag)
                const commonClasses = cn(
                  'rounded-full border px-2 py-0.5 text-[10px] font-medium',
                  tc.bg, tc.text, tc.border,
                )
                if (onTagClick) {
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={e => { e.stopPropagation(); onTagClick(tag) }}
                      className={cn(
                        commonClasses,
                        'cursor-pointer hover:brightness-110 hover:-translate-y-[1px] active:translate-y-0 transition-transform duration-75',
                      )}
                      title={`Filter by tag: ${tag}`}
                    >
                      {tag}
                    </button>
                  )
                }
                return (
                  <span key={tag} className={commonClasses}>
                    {tag}
                  </span>
                )
              })}
              {overflowCount > 0 && (
                <span className="rounded-full bg-black/[0.06] dark:bg-white/[0.08] px-2 py-0.5 text-[10px] font-medium text-ink-muted">
                  +{overflowCount}
                </span>
              )}
            </div>
          )}
        </div>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* ── 8. Footer ── */}
        <div className="flex items-center gap-2 border-t border-glass-border/50 pt-3 mt-1">
          {/* Favourite — left */}
          <span className={cn(
            'inline-flex items-center gap-1 text-[11px] font-medium',
            view.isFavourited ? 'text-red-500' : 'text-ink-muted',
          )}>
            <Heart className="h-3 w-3" fill={view.isFavourited ? 'currentColor' : 'none'} />
            {view.favouriteCount}
          </span>

          {/* Creator — middle.
              Compact initials-only avatar; hover reveals the
              CreatorHoverCard with full name + email + user id so the
              card footer stays uncluttered next to favourite / sync
              indicators. */}
          {(view.createdByName || view.createdBy) && (() => {
            const displayName = view.createdByName ?? view.createdBy ?? ''
            return (
              <CreatorHoverCard
                userId={view.createdBy ?? null}
                displayName={view.createdByName ?? null}
                email={view.createdByEmail ?? null}
                accentClassName={meta.iconBg}
              >
                <div
                  className={cn(
                    'w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold shrink-0 cursor-default',
                    meta.iconBg,
                  )}
                  aria-label={`Creator: ${displayName}`}
                  tabIndex={0}
                >
                  {initials(displayName)}
                </div>
              </CreatorHoverCard>
            )
          })()}

          {/* Sync indicator — right */}
          {(() => {
            const ageDays = (Date.now() - new Date(view.updatedAt).getTime()) / (1000 * 60 * 60 * 24)
            const syncColor = ageDays <= 7 ? 'text-emerald-500' : ageDays <= 30 ? 'text-amber-500' : 'text-red-500'
            return (
              <span className={cn('inline-flex items-center gap-1 text-[10px] font-medium ml-auto', syncColor)}>
                <RefreshCw className="h-2.5 w-2.5" />
                {timeAgo(view.updatedAt)}
              </span>
            )
          })()}
        </div>
      </div>
    </div>
  )
}
