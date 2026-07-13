import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Heart,
  Link2,
  Globe,
  Users,
  Lock,
  Box,
  Database,
  ExternalLink,
  Pencil,
  Check,
  Trash2,
  RotateCcw,
  History,
} from 'lucide-react'
import type { View } from '@/services/viewApiService'
import type { DataSourceProviderInfo } from '@/components/admin/workspace/useWorkspaceDetailData'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { TimeStamp } from '@/components/ui/TimeStamp'
import { DynamicIcon, resolveViewIcon, viewTypeMeta } from '@/lib/viewUtils'
import { CreatorHoverCard } from '@/components/explorer/CreatorHoverCard'
import { HeartBurstButton } from '@/components/explorer/HeartBurstButton'
import { ViewActivityDrawer } from '@/components/views/ViewActivityDrawer'

/* ------------------------------------------------------------------ */
/*  View type icon + themed color mapping                              */
/* ------------------------------------------------------------------ */

// View type theme comes from the SHARED resolver — see viewTypeMeta() in
// lib/viewUtils. Do not reintroduce a local map (that drift is what made the
// recents strip show a different icon/colour for the same view).

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
  /** Opens the full builder (ViewWizard) — entity scope, layers, layout. */
  onEditLayout?: () => void
  editDisabled?: boolean
  onDelete?: () => void
  onRestore?: () => void
  onPermanentDelete?: () => void
  healthStatus?: 'healthy' | 'warning' | 'broken' | 'stale'
  isSelected?: boolean
  onToggleSelect?: () => void
  /** Visual density — controls vertical padding. */
  density?: 'compact' | 'comfortable' | 'spacious'
  /** Provider the view's data source is built from (shown as a scope pill). */
  providerInfo?: DataSourceProviderInfo
  /** Hide the (redundant) workspace pill when the whole list is one workspace. */
  hideWorkspaceInScope?: boolean
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
  providerInfo,
  hideWorkspaceInScope,
}: ExplorerListRowProps) {
  const typeMeta = viewTypeMeta(view.viewType)
  // Glyph = user-chosen icon when set; tile colors stay type identity.
  const iconName = resolveViewIcon({ icon: view.config?.icon, viewType: view.viewType })
  const VisIcon = VISIBILITY_ICON[view.visibility] ?? Lock
  const isDeleted = !!view.deletedAt
  const [activityOpen, setActivityOpen] = useState(false)

  // Density → row padding. Comfortable is the visual default from before
  // the toggle existed, so existing screenshots stay unchanged at default.
  const densityPaddingClass =
    density === 'compact' ? 'py-1.5'
    : density === 'spacious' ? 'py-4'
    : 'py-2.5'

  return (
    <>
    <ViewActivityDrawer
      viewId={activityOpen ? view.id : null}
      viewName={view.name}
      isOpen={activityOpen}
      onClose={() => setActivityOpen(false)}
    />
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
            ? 'grid-cols-[28px_minmax(0,1.5fr)_minmax(0,1.1fr)_90px_36px_110px_70px_80px_140px]'
            : 'grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_90px_36px_110px_70px_80px_140px]',
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
              typeMeta.iconBg,
            )}
          >
            <DynamicIcon name={iconName} className="h-3.5 w-3.5" />
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

        {/* ── Scope ──
             A table column cannot fit three chips legibly — they truncated to
             "Major R…" / "Dat…" / "Falk…". Surface the DATA SOURCE as readable
             text (the scope users actually scan for), with workspace · provider
             as a muted second line. Full values stay available on hover. The
             chip trio is still the right call on cards, which have the width. */}
        <div className="min-w-0 overflow-hidden">
          {view.dataSourceName || view.dataSourceId ? (
            <div className="flex items-center gap-1.5 min-w-0">
              <Database className="h-3 w-3 text-emerald-500 shrink-0" />
              <span
                className="truncate text-xs font-medium text-ink"
                title={view.dataSourceName ?? view.dataSourceId ?? ''}
              >
                {view.dataSourceName ?? view.dataSourceId}
              </span>
            </div>
          ) : (
            <span className="text-xs text-ink-muted">—</span>
          )}
          <div className="flex items-center gap-1 min-w-0 text-[10px] text-ink-muted leading-tight">
            {!hideWorkspaceInScope && view.workspaceName && (
              <span className="truncate" title={view.workspaceName}>{view.workspaceName}</span>
            )}
            {!hideWorkspaceInScope && view.workspaceName && providerInfo?.providerName && (
              <span className="shrink-0">·</span>
            )}
            {providerInfo?.providerName && (
              <span
                className="truncate"
                title={`Provider: ${providerInfo.providerName}${providerInfo.providerType ? ` · ${providerInfo.providerType}` : ''}`}
              >
                {providerInfo.providerName}
              </span>
            )}
          </div>
        </div>

        {/* ── Type label ── */}
        <span className="text-xs text-ink-muted">
          {typeMeta.label}
        </span>

        {/* ── Visibility icon ── */}
        <VisIcon className="h-3.5 w-3.5 text-ink-muted" />

        {/* ── Owner ──
             Prefer the server-resolved display name; fall back to "Unknown"
             when unresolvable — never the raw user id. The CreatorHoverCard
             shows full name + email on hover so power users can disambiguate
             without taking a round-trip to the view detail drawer. */}
        {(view.createdByName || view.createdBy) ? (
          <CreatorHoverCard
            userId={view.createdBy ?? null}
            displayName={view.createdByName ?? null}
            email={view.createdByEmail ?? null}
          >
            <span className="truncate text-xs text-ink-muted cursor-default" tabIndex={0}>
              {view.createdByName ?? 'Unknown'}
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

        {/* ── Updated — freshest of settings-edit vs data-publish; tooltip tells both.
               This row printed FLAT GREY while the card beside it carried the
               age-coloured chip: the same view, two different stories about how
               stale it is, depending on which layout you happened to pick. ── */}
        {(() => {
          const dataAt = view.dataUpdatedAt ?? null
          const freshest = dataAt && dataAt > view.updatedAt ? dataAt : view.updatedAt
          return (
            <TimeStamp
              at={freshest}
              icon={null}
              tooltipLines={[
                dataAt && `Data updated ${timeAgo(dataAt)}${view.dataUpdatedByName ? ` by ${view.dataUpdatedByName}` : ''}`,
                `Settings edited ${timeAgo(view.updatedAt)}${view.updatedByName ? ` by ${view.updatedByName}` : ''}`,
              ]}
            />
          )
        })()}

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
              <button
                type="button"
                onClick={e => { e.stopPropagation(); setActivityOpen(true) }}
                className="rounded-lg p-1.5 text-ink-muted transition-colors duration-150 hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
                title="Activity"
              >
                <History className="h-3.5 w-3.5" />
              </button>
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
                    title="Edit details (name, description, tags, visibility)"
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
    </>
  )
}
