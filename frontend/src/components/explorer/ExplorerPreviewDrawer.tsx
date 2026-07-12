/**
 * ExplorerPreviewDrawer — Slide-in side panel for quick-previewing a view.
 *
 * Shows: view type, name, description, tags, workspace, visibility,
 * data source, semantic layer, layout, created/updated dates,
 * last synced, favourite count, and a mini preview for hierarchy/reference.
 */
import { useState, useRef, useCallback, useEffect } from 'react'
import { History, Save, Settings2, Check } from 'lucide-react'
import { ViewActivityDrawer } from '@/components/views/ViewActivityDrawer'
import { updateView, type View as ViewT } from '@/services/viewApiService'
import { useToast } from '@/components/ui/toast'
import { Link } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { MOTION } from '@/lib/motion'
import {
  X,
  Heart,
  Share2,
  Trash2,
  Tag,
  Lock,
  Users,
  Globe,
  Calendar,
  User,
  ExternalLink,
  Pencil,
  Network,
  GitBranch,
  Layout,
  Table2,
  Layers,
  Database,
  Box,
  RefreshCw,
  LayoutDashboard,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import type { View } from '@/services/viewApiService'
import type { DataSourceProviderInfo } from '@/components/admin/workspace/useWorkspaceDetailData'
import { ViewScopeBadge } from '@/components/explorer/ViewScopeBadge'
import { Backdrop } from '@/components/ui/Backdrop'
import type { ViewLayerConfig } from '@/types/schema'

// ─── Types ──────────────────────────────────────────────────────

interface ExplorerPreviewDrawerProps {
  view: View | null
  isOpen: boolean
  onClose: () => void
  onToggleFavourite: () => void
  onShare: () => void
  /** Opens the full builder (ViewWizard) — labelled "Edit layout & scope". */
  onEdit?: () => void
  editDisabled?: boolean
  onDelete?: () => void
  healthStatus?: 'healthy' | 'warning' | 'broken' | 'stale'
  /** Provider the view's data source is built from (shown as a scope pill). */
  providerInfo?: DataSourceProviderInfo
  /** Open directly in details-edit mode (used when the pencil is clicked). */
  initialEditMode?: boolean
  /** Called after a successful details save so the host can refetch. */
  onSaved?: () => void
}

// ─── Constants ──────────────────────────────────────────────────

const VISIBILITY_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  private: { label: 'Private', icon: Lock },
  workspace: { label: 'Workspace', icon: Users },
  enterprise: { label: 'Enterprise', icon: Globe },
}

const VIEW_TYPE_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; color: string }> = {
  graph: { label: 'Graph', icon: Network, color: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-500' },
  hierarchy: { label: 'Hierarchy', icon: GitBranch, color: 'bg-violet-500/10 border-violet-500/20 text-violet-500' },
  'layered-lineage': { label: 'Lineage', icon: Layers, color: 'bg-amber-500/10 border-amber-500/20 text-amber-500' },
  table: { label: 'Table', icon: Table2, color: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500' },
  reference: { label: 'Context View', icon: Layout, color: 'bg-rose-500/10 border-rose-500/20 text-rose-500' },
}

const DEFAULT_TYPE = { label: 'View', icon: Layout, color: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-500' }

// ─── Format date to readable string ─────────────────────────────

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return dateStr
  }
}

// ─── Mini preview SVGs for hierarchy / reference ────────────────

function HierarchyPreview() {
  return (
    <svg viewBox="0 0 280 100" className="w-full h-24 text-violet-500/30">
      {/* Root */}
      <circle cx="140" cy="16" r="8" fill="currentColor" />
      <text x="140" y="19" textAnchor="middle" fontSize="7" fill="white" fontWeight="bold">R</text>
      {/* Level 1 */}
      <line x1="140" y1="24" x2="60" y2="48" stroke="currentColor" strokeWidth="1.5" />
      <line x1="140" y1="24" x2="140" y2="48" stroke="currentColor" strokeWidth="1.5" />
      <line x1="140" y1="24" x2="220" y2="48" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="60" cy="54" r="7" fill="currentColor" />
      <circle cx="140" cy="54" r="7" fill="currentColor" />
      <circle cx="220" cy="54" r="7" fill="currentColor" />
      {/* Level 2 */}
      <line x1="60" y1="61" x2="30" y2="82" stroke="currentColor" strokeWidth="1" opacity="0.6" />
      <line x1="60" y1="61" x2="90" y2="82" stroke="currentColor" strokeWidth="1" opacity="0.6" />
      <line x1="220" y1="61" x2="195" y2="82" stroke="currentColor" strokeWidth="1" opacity="0.6" />
      <line x1="220" y1="61" x2="245" y2="82" stroke="currentColor" strokeWidth="1" opacity="0.6" />
      <circle cx="30" cy="86" r="5" fill="currentColor" opacity="0.5" />
      <circle cx="90" cy="86" r="5" fill="currentColor" opacity="0.5" />
      <circle cx="195" cy="86" r="5" fill="currentColor" opacity="0.5" />
      <circle cx="245" cy="86" r="5" fill="currentColor" opacity="0.5" />
    </svg>
  )
}

/** Data-driven reference model layer preview with scroll controls */
function ReferenceLayerPreview({ layers }: { layers: ViewLayerConfig[] }) {
  const sorted = [...layers].sort((a, b) => (a.order ?? a.sequence ?? 0) - (b.order ?? b.sequence ?? 0))
  const scrollable = sorted.length > 3
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 2)
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 2)
  }, [])

  useEffect(() => {
    updateScrollState()
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', updateScrollState, { passive: true })
    const ro = new ResizeObserver(updateScrollState)
    ro.observe(el)
    return () => { el.removeEventListener('scroll', updateScrollState); ro.disconnect() }
  }, [updateScrollState, layers])

  const scroll = useCallback((dir: 'left' | 'right') => {
    scrollRef.current?.scrollBy({ left: dir === 'left' ? -160 : 160, behavior: 'smooth' })
  }, [])

  return (
    <div className="relative">
      {/* Scroll container */}
      <div
        ref={scrollRef}
        className={cn(
          'flex gap-2',
          scrollable && 'overflow-x-auto scrollbar-none [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]',
        )}
      >
        {sorted.map((layer) => {
          const color = layer.color ?? '#f43f5e'
          const entityCount = layer.entityTypes?.length ?? 0
          return (
            <div
              key={layer.id}
              className={cn(
                'rounded-lg border overflow-hidden',
                scrollable ? 'flex-shrink-0 w-[140px]' : 'flex-1 min-w-0',
              )}
              style={{ borderColor: `${color}30` }}
            >
              {/* Layer header bar */}
              <div
                className="px-2.5 py-2 flex items-center gap-1.5"
                style={{ backgroundColor: `${color}10` }}
              >
                <div
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: color }}
                />
                <span
                  className="text-[10px] font-bold truncate"
                  style={{ color }}
                >
                  {layer.name}
                </span>
              </div>
              {/* Layer body */}
              <div className="px-2.5 py-2 space-y-1.5">
                {layer.description && (
                  <p className="text-[9px] text-ink-muted/70 leading-tight line-clamp-2">
                    {layer.description}
                  </p>
                )}
                {entityCount > 0 ? (
                  <div className="flex flex-wrap gap-0.5">
                    {layer.entityTypes.slice(0, 3).map(et => (
                      <span
                        key={et}
                        className="rounded px-1 py-0.5 text-[8px] font-medium truncate max-w-full"
                        style={{ backgroundColor: `${color}12`, color }}
                      >
                        {et}
                      </span>
                    ))}
                    {entityCount > 3 && (
                      <span
                        className="rounded px-1 py-0.5 text-[8px] font-medium"
                        style={{ backgroundColor: `${color}12`, color }}
                      >
                        +{entityCount - 3}
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="text-[9px] text-ink-muted/40 italic">No types assigned</span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Fade edges + arrow buttons */}
      {scrollable && (
        <>
          {/* Left fade + button */}
          <div
            className={cn(
              'absolute left-0 top-0 bottom-0 w-8 bg-gradient-to-r from-black/[0.04] dark:from-white/[0.04] to-transparent pointer-events-none transition-opacity duration-200',
              canScrollLeft ? 'opacity-100' : 'opacity-0',
            )}
          />
          {canScrollLeft && (
            <button
              onClick={() => scroll('left')}
              className="absolute left-0 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-canvas-elevated border border-glass-border shadow-md flex items-center justify-center text-ink-muted hover:text-ink transition-colors duration-150"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
          )}

          {/* Right fade + button */}
          <div
            className={cn(
              'absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-black/[0.04] dark:from-white/[0.04] to-transparent pointer-events-none transition-opacity duration-200',
              canScrollRight ? 'opacity-100' : 'opacity-0',
            )}
          />
          {canScrollRight && (
            <button
              onClick={() => scroll('right')}
              className="absolute right-0 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-canvas-elevated border border-glass-border shadow-md flex items-center justify-center text-ink-muted hover:text-ink transition-colors duration-150"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          )}
        </>
      )}
    </div>
  )
}

/** Fallback static SVG when no layers configured */
function ReferencePreviewFallback() {
  return (
    <svg viewBox="0 0 280 100" className="w-full h-24 text-rose-500/25">
      {[0, 1, 2, 3].map(col => (
        <g key={`r1-${col}`}>
          <rect x={8 + col * 70} y={8} width={60} height={36} rx="4" fill="currentColor" opacity={1 - col * 0.15} />
          <line x1={14 + col * 70} y1={18} x2={56 + col * 70} y2={18} stroke="white" strokeWidth="1.5" opacity="0.4" />
          <line x1={14 + col * 70} y1={24} x2={46 + col * 70} y2={24} stroke="white" strokeWidth="1" opacity="0.25" />
        </g>
      ))}
      {[0, 1, 2].map(col => (
        <g key={`r2-${col}`}>
          <rect x={8 + col * 70} y={52} width={60} height={36} rx="4" fill="currentColor" opacity={0.7 - col * 0.15} />
          <line x1={14 + col * 70} y1={62} x2={56 + col * 70} y2={62} stroke="white" strokeWidth="1.5" opacity="0.4" />
        </g>
      ))}
    </svg>
  )
}

// ─── Detail row helper ──────────────────────────────────────────

function DetailRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-7 h-7 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] flex items-center justify-center shrink-0 mt-0.5">
        <Icon className="h-3.5 w-3.5 text-ink-muted" />
      </div>
      <div className="min-w-0 flex-1">
        <span className="text-[10px] uppercase tracking-widest font-bold text-ink-muted block mb-0.5">
          {label}
        </span>
        <span className="text-sm font-medium text-ink">{value}</span>
      </div>
    </div>
  )
}

// ─── Component ──────────────────────────────────────────────────

export function ExplorerPreviewDrawer({
  view,
  isOpen,
  onClose,
  onToggleFavourite,
  onShare,
  onEdit,
  editDisabled,
  onDelete,
  healthStatus,
  providerInfo,
  initialEditMode,
  onSaved,
}: ExplorerPreviewDrawerProps) {
  const [activityOpen, setActivityOpen] = useState(false)
  const [editMode, setEditMode] = useState(!!initialEditMode)
  // Reset edit mode when the drawer opens for a (possibly different) view or the
  // caller's intent changes — pencil opens in edit mode, a click opens in view mode.
  useEffect(() => {
    setEditMode(isOpen ? !!initialEditMode : false)
  }, [view?.id, isOpen, initialEditMode])
  const content = (
    <>
      <ViewActivityDrawer
        viewId={activityOpen && view ? view.id : null}
        viewName={view?.name}
        isOpen={activityOpen}
        onClose={() => setActivityOpen(false)}
      />
      {/* Backdrop — plain CSS transition, never inside AnimatePresence (fixes the
          StrictMode click-shield where a stranded fixed-inset-0 node eats clicks). */}
      <Backdrop open={!!(isOpen && view)} onClick={onClose} zClassName="z-[60]" />

      {/* Drawer panel — keyed single child so AnimatePresence tracks its exit cleanly */}
      <AnimatePresence>
        {isOpen && view && (
          <motion.aside
            key="explorer-preview-drawer"
            className={cn(
              'fixed right-0 top-0 h-full w-[440px] max-w-[90vw] z-[61]',
              'bg-canvas border-l border-glass-border',
              'flex flex-col overflow-y-auto custom-scrollbar',
              'shadow-lg',
            )}
            initial={{ x: 440 }}
            animate={{ x: 0 }}
            exit={{ x: 440 }}
            transition={MOTION.drawerSlide}
          >
            {/* ── Header ── */}
            <div className="flex items-start justify-between gap-3 px-6 pt-6 pb-5 border-b border-glass-border/50">
              <div className="flex-1 min-w-0">
                {(() => {
                  const typeMeta = VIEW_TYPE_META[view.viewType] ?? DEFAULT_TYPE
                  const TypeIcon = typeMeta.icon
                  return (
                    <div className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold mb-3', typeMeta.color)}>
                      <TypeIcon className="h-3 w-3" />
                      {typeMeta.label} View
                    </div>
                  )
                })()}
                <h2 className="text-ink text-lg font-bold leading-tight">
                  {view.name}
                </h2>
              </div>
              <button
                onClick={onClose}
                className="flex-shrink-0 p-2 rounded-xl text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors duration-150"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* ── Health warning banner ── */}
            {healthStatus && healthStatus !== 'healthy' && (
              <div className={cn(
                'mx-6 mt-4 rounded-xl border px-4 py-3 flex items-start gap-3',
                healthStatus === 'broken'
                  ? 'bg-red-50 dark:bg-red-500/[0.08] border-red-200 dark:border-red-500/20'
                  : 'bg-amber-50 dark:bg-amber-500/[0.08] border-amber-200 dark:border-amber-500/20',
              )}>
                <AlertTriangle className={cn(
                  'h-4 w-4 shrink-0 mt-0.5',
                  healthStatus === 'broken' ? 'text-red-500' : 'text-amber-500',
                )} />
                <div>
                  <p className={cn(
                    'text-sm font-semibold',
                    healthStatus === 'broken' ? 'text-red-700 dark:text-red-400' : 'text-amber-700 dark:text-amber-400',
                  )}>
                    {healthStatus === 'broken' && 'Data source has been deleted'}
                    {healthStatus === 'warning' && 'Data source may have changed'}
                    {healthStatus === 'stale' && 'View has not been updated recently'}
                  </p>
                  <p className={cn(
                    'text-xs mt-0.5',
                    healthStatus === 'broken' ? 'text-red-600/70 dark:text-red-400/70' : 'text-amber-600/70 dark:text-amber-400/70',
                  )}>
                    {healthStatus === 'broken'
                      ? 'This view may not load correctly. Consider deleting it.'
                      : healthStatus === 'warning'
                        ? 'The underlying data source configuration has changed.'
                        : 'This view has not been synced in over 90 days.'}
                  </p>
                </div>
              </div>
            )}

            {/* ── Body ── */}
            <div className="flex-1 px-6 py-5 space-y-5">
              {editMode && view ? (
                <EditDetailsPanel view={view} onCancel={() => setEditMode(false)} onSaved={onSaved} />
              ) : (
              <>
              {/* Workspace + Visibility badges */}
              <div className="flex items-center gap-2 flex-wrap">
                <ViewScopeBadge
                  workspaceId={view.workspaceId}
                  workspaceName={view.workspaceName}
                  dataSourceId={view.dataSourceId}
                  dataSourceName={view.dataSourceName}
                  providerName={providerInfo?.providerName}
                  providerType={providerInfo?.providerType}
                  size="md"
                />
                {(() => {
                  const vis = VISIBILITY_META[view.visibility] ?? VISIBILITY_META.private
                  const VisIcon = vis.icon
                  return (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-black/[0.04] dark:bg-white/[0.06] px-3 py-1 text-xs font-medium text-ink-muted">
                      <VisIcon className="h-3 w-3" />
                      {vis.label}
                    </span>
                  )
                })()}
              </div>

              {/* Mini preview for hierarchy */}
              {view.viewType === 'hierarchy' && (
                <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-3 overflow-hidden">
                  <span className="text-[10px] uppercase tracking-widest font-bold text-ink-muted block mb-2">
                    Preview
                  </span>
                  <HierarchyPreview />
                </div>
              )}

              {/* Reference model layers — data-driven */}
              {view.viewType === 'reference' && (() => {
                const layers: ViewLayerConfig[] = view.config?.layout?.referenceLayout?.layers ?? []
                return (
                  <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-3 overflow-hidden">
                    <span className="text-[10px] uppercase tracking-widest font-bold text-ink-muted block mb-2">
                      Reference Model Layers
                      {layers.length > 0 && (
                        <span className="ml-1.5 text-ink-muted/50 normal-case tracking-normal">
                          ({layers.length})
                        </span>
                      )}
                    </span>
                    {layers.length > 0
                      ? <ReferenceLayerPreview layers={layers} />
                      : <ReferencePreviewFallback />
                    }
                  </div>
                )
              })()}

              {/* Description */}
              <div>
                <h4 className="text-[10px] uppercase tracking-widest font-bold text-ink-muted mb-2">
                  Description
                </h4>
                {view.description ? (
                  <p className="text-sm leading-relaxed text-ink">{view.description}</p>
                ) : (
                  <p className="text-sm text-ink-muted/50 italic">No description provided</p>
                )}
              </div>

              {/* Tags */}
              {view.tags && view.tags.length > 0 && (
                <div>
                  <h4 className="text-[10px] uppercase tracking-widest font-bold text-ink-muted mb-2">
                    Tags
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {view.tags.map(tag => (
                      <span
                        key={tag}
                        className="inline-flex items-center gap-1 rounded-full bg-black/[0.04] dark:bg-white/[0.06] border border-glass-border px-2.5 py-1 text-xs font-medium text-ink-muted"
                      >
                        <Tag className="h-3 w-3" />
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Key details grid */}
              <div>
                <h4 className="text-[10px] uppercase tracking-widest font-bold text-ink-muted mb-3">
                  Details
                </h4>
                <div className="space-y-3">
                  {/* View type + layout */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-3">
                      <span className="text-[10px] uppercase tracking-widest font-bold text-ink-muted block mb-1.5">
                        View Type
                      </span>
                      <div className="flex items-center gap-2">
                        {(() => {
                          const typeMeta = VIEW_TYPE_META[view.viewType] ?? DEFAULT_TYPE
                          const TypeIcon = typeMeta.icon
                          return (
                            <>
                              <div className={cn('w-6 h-6 rounded-lg border flex items-center justify-center', typeMeta.color)}>
                                <TypeIcon className="h-3 w-3" />
                              </div>
                              <span className="text-sm font-semibold text-ink">{typeMeta.label}</span>
                            </>
                          )
                        })()}
                      </div>
                    </div>
                    <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-3">
                      <span className="text-[10px] uppercase tracking-widest font-bold text-ink-muted block mb-1.5">
                        Layout
                      </span>
                      <div className="flex items-center gap-2">
                        <LayoutDashboard className="h-4 w-4 text-ink-muted" />
                        <span className="text-sm font-semibold text-ink capitalize">
                          {view.config?.layout?.type ?? 'Default'}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Semantic layer */}
                  {view.contextModelName && (
                    <DetailRow
                      icon={Box}
                      label="Semantic Layer"
                      value={view.contextModelName}
                    />
                  )}

                  {/* Data source */}
                  {view.dataSourceId && (
                    <DetailRow
                      icon={Database}
                      label="Data Source"
                      value={view.dataSourceName ?? view.dataSourceId}
                    />
                  )}

                  {/* Created by — prefer the server-resolved display name;
                      fall back to "Unknown" when unresolvable — never the
                      raw id (kept in a title attr for debugging). Email
                      renders as a subtle secondary line so operators can
                      reach out without leaving the drawer. */}
                  {(view.createdByName || view.createdBy) && (
                    <DetailRow
                      icon={User}
                      label="Created By"
                      value={
                        <span className="flex flex-col min-w-0">
                          <span className="font-medium text-ink truncate" title={view.createdBy}>
                            {view.createdByName ?? 'Unknown'}
                          </span>
                          {view.createdByEmail && (
                            <a
                              href={`mailto:${view.createdByEmail}`}
                              className="text-[11px] text-ink-muted hover:text-accent-lineage transition-colors truncate"
                            >
                              {view.createdByEmail}
                            </a>
                          )}
                        </span>
                      }
                    />
                  )}

                  {/* Created at */}
                  <DetailRow
                    icon={Calendar}
                    label="Created"
                    value={
                      <span>
                        {formatDate(view.createdAt)}
                        <span className="text-ink-muted text-xs ml-1.5">({timeAgo(view.createdAt)})</span>
                      </span>
                    }
                  />

                  {/* Updated — the view's own settings/details edits (rename, layout,
                      description, tags). Distinct from "Data Updated" below. */}
                  <DetailRow
                    icon={Calendar}
                    label="Updated"
                    value={
                      <span className="flex flex-col min-w-0">
                        <span>
                          {formatDate(view.updatedAt)}
                          <span className="text-ink-muted text-xs ml-1.5">({timeAgo(view.updatedAt)})</span>
                        </span>
                        {view.updatedByName && (
                          <span className="text-[11px] text-ink-muted truncate">by {view.updatedByName}</span>
                        )}
                      </span>
                    }
                  />

                  {/* Data Updated — when the underlying lineage data last changed
                      (a publish or merged change on this view's data source). This is the
                      value that reflects "I just merged changes to this view". */}
                  <DetailRow
                    icon={RefreshCw}
                    label="Data Updated"
                    value={
                      view.dataUpdatedAt ? (
                        <span className="flex flex-col min-w-0">
                          <span>
                            {formatDate(view.dataUpdatedAt)}
                            <span className="text-ink-muted text-xs ml-1.5">({timeAgo(view.dataUpdatedAt)})</span>
                          </span>
                          {view.dataUpdatedByName && (
                            <span className="text-[11px] text-ink-muted truncate">by {view.dataUpdatedByName}</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-ink-muted">No published changes yet</span>
                      )
                    }
                  />
                </div>
              </div>

              {/* Favourite section */}
              <div className="flex items-center gap-3 pt-3 border-t border-glass-border/50">
                <button
                  onClick={onToggleFavourite}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors duration-200',
                    view.isFavourited
                      ? 'bg-red-500/10 text-red-500 border border-red-500/20 hover:bg-red-500/15'
                      : 'border border-glass-border text-ink-muted hover:text-red-500 hover:border-red-500/30 bg-black/[0.02] dark:bg-white/[0.02]',
                  )}
                >
                  <Heart
                    className="h-4 w-4"
                    fill={view.isFavourited ? 'currentColor' : 'none'}
                  />
                  {view.isFavourited ? 'Favourited' : 'Favourite'}
                </button>
                <span className="text-ink-muted text-xs font-medium">
                  {view.favouriteCount}{' '}
                  {view.favouriteCount === 1 ? 'favourite' : 'favourites'}
                </span>
              </div>
              </>
            )}
            </div>

            {/* ── Footer actions ── (hidden while editing details) */}
            {!editMode && (
            <div className="px-6 py-5 border-t border-glass-border/50 space-y-3">
              {/* Primary action — full width */}
              <Link
                to={`/views/${view.id}`}
                className={cn(
                  'w-full inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3',
                  'bg-gradient-to-r from-accent-lineage to-violet-600 text-white text-sm font-semibold',
                  'shadow-lg shadow-accent-lineage/25',
                  'hover:shadow-xl hover:-translate-y-0.5',
                  'transition-[transform,box-shadow] duration-200',
                )}
              >
                <ExternalLink className="h-4 w-4" />
                Open Full View
              </Link>
              {onEdit && (
                <button
                  onClick={() => { if (!editDisabled) onEdit() }}
                  disabled={editDisabled}
                  title={editDisabled
                    ? "Switch to this view's workspace to edit"
                    : 'Open the builder to change entity scope, layers, filters and layout'}
                  className={cn(
                    'w-full inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold',
                    'border border-accent-lineage/40 text-accent-lineage bg-accent-lineage/5',
                    'hover:bg-accent-lineage/10 transition-colors duration-200',
                    editDisabled && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  <Settings2 className="h-4 w-4" /> Edit layout &amp; scope
                </button>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setEditMode(true)}
                  className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 border border-glass-border text-sm font-medium text-ink-muted hover:text-ink hover:border-indigo-500/30 transition-colors"
                >
                  <Pencil className="h-4 w-4" /> Edit details
                </button>
                <button
                  onClick={() => setActivityOpen(true)}
                  className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 border border-glass-border text-sm font-medium text-ink-muted hover:text-ink hover:border-indigo-500/30 transition-colors"
                >
                  <History className="h-4 w-4" /> Activity
                </button>
              </div>
              {/* Secondary actions row */}
              <div className="flex items-center gap-2">
                <button
                  onClick={onShare}
                  className={cn(
                    'flex-1 inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2.5',
                    'border border-glass-border text-sm font-medium text-ink-muted',
                    'bg-black/[0.02] dark:bg-white/[0.02]',
                    'hover:text-ink hover:border-glass-border/80 transition-colors duration-200',
                  )}
                >
                  <Share2 className="h-3.5 w-3.5" />
                  Share
                </button>
                {onDelete && (
                  <button
                    onClick={onDelete}
                    className={cn(
                      'flex-1 inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2.5',
                      'border border-red-200 dark:border-red-500/20 text-sm font-medium',
                      'text-red-500 bg-red-50/50 dark:bg-red-500/[0.06]',
                      'hover:bg-red-100 dark:hover:bg-red-500/15 hover:border-red-300 dark:hover:border-red-500/30 transition-colors duration-200',
                    )}
                    title="Delete view"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </button>
                )}
              </div>
            </div>
            )}
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  )

  // Render via portal to avoid z-index / overflow issues
  return createPortal(content, document.body)
}

/**
 * EditDetailsPanel — lightweight in-drawer form for a view's metadata
 * (name, description, tags, visibility). Saves via the existing PUT /views/{id}
 * — no wizard — and the change is captured by the activity log's field diff.
 * Structural edits (scope/layers/layout) stay in the builder ("Edit layout & scope").
 */
function EditDetailsPanel({ view, onCancel, onSaved }: {
  view: ViewT
  onCancel: () => void
  onSaved?: () => void
}) {
  const { showToast } = useToast()
  const [name, setName] = useState(view.name)
  const [description, setDescription] = useState(view.description ?? '')
  const [tagList, setTagList] = useState<string[]>(view.tags ?? [])
  const [tagInput, setTagInput] = useState('')
  const [visibility, setVisibility] = useState<string>(view.visibility)
  const [saving, setSaving] = useState(false)

  const origTags = (view.tags ?? []).join('|')
  const dirty = name !== view.name
    || (description || '') !== (view.description || '')
    || tagList.join('|') !== origTags
    || visibility !== view.visibility

  const addTag = (raw: string) => {
    const t = raw.replace(/,+$/, '').trim()
    if (t && !tagList.includes(t)) setTagList(prev => [...prev, t])
    setTagInput('')
  }
  const removeTag = (t: string) => setTagList(prev => prev.filter(x => x !== t))

  const handleSave = async () => {
    if (!name.trim()) { showToast('error', 'Name is required'); return }
    setSaving(true)
    try {
      await updateView(view.id, {
        name: name.trim(),
        description: description.trim() || undefined,
        tags: tagList,
        visibility,
      })
      showToast('success', 'View details updated')
      onSaved?.()
      onCancel()
    } catch {
      showToast('error', 'Couldn’t save changes')
    } finally {
      setSaving(false)
    }
  }

  const VIS = [
    { value: 'private', icon: Lock, label: 'Private', desc: 'Only you can see it' },
    { value: 'workspace', icon: Users, label: 'Workspace', desc: 'Everyone in this workspace' },
    { value: 'enterprise', icon: Globe, label: 'Enterprise', desc: 'Everyone in the organisation' },
  ] as const

  const labelCls = 'block text-[11px] font-bold uppercase tracking-wider text-ink-muted mb-1.5'
  const inputCls = 'w-full px-3.5 py-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-sm text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-accent-lineage/40 focus:border-accent-lineage/40 transition-shadow'

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-bold text-ink">Edit details</h3>
        <p className="text-xs text-ink-muted mt-0.5 leading-relaxed">
          Name, description, tags and visibility. To change entity scope, layers or layout use{' '}
          <span className="font-medium text-ink">Edit layout &amp; scope</span>.
        </p>
      </div>

      <div>
        <label className={labelCls}>Name</label>
        <input value={name} onChange={e => setName(e.target.value)} className={inputCls} placeholder="View name" autoFocus />
      </div>

      <div>
        <label className={labelCls}>Description</label>
        <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} className={cn(inputCls, 'resize-none')} placeholder="What does this view show? (optional)" />
      </div>

      <div>
        <label className={labelCls}>Tags</label>
        <div className={cn(inputCls, 'flex flex-wrap items-center gap-1.5 py-2 cursor-text')}>
          {tagList.map(t => (
            <span key={t} className="inline-flex items-center gap-1 rounded-full bg-accent-lineage/10 text-accent-lineage border border-accent-lineage/20 pl-2 pr-1 py-0.5 text-xs font-medium">
              {t}
              <button type="button" onClick={() => removeTag(t)} className="rounded-full hover:bg-accent-lineage/20 p-0.5" aria-label={`Remove ${t}`}>
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          <input
            value={tagInput}
            onChange={e => { const v = e.target.value; if (v.endsWith(',')) addTag(v); else setTagInput(v) }}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); addTag(tagInput) }
              else if (e.key === 'Backspace' && !tagInput && tagList.length) removeTag(tagList[tagList.length - 1])
            }}
            onBlur={() => tagInput && addTag(tagInput)}
            placeholder={tagList.length ? 'Add…' : 'e.g. finance, quarterly'}
            className="flex-1 min-w-[90px] bg-transparent text-sm text-ink placeholder:text-ink-muted/60 focus:outline-none"
          />
        </div>
        <p className="text-[10px] text-ink-muted mt-1">Press Enter or comma to add a tag.</p>
      </div>

      <div>
        <label className={labelCls}>Visibility</label>
        <div className="space-y-2">
          {VIS.map(({ value, icon: Icon, label, desc }) => {
            const active = visibility === value
            return (
              <button
                key={value}
                type="button"
                onClick={() => setVisibility(value)}
                className={cn(
                  'w-full flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors',
                  active
                    ? 'border-accent-lineage/50 bg-accent-lineage/[0.06]'
                    : 'border-glass-border bg-black/[0.02] dark:bg-white/[0.02] hover:border-accent-lineage/30',
                )}
              >
                <span className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border', active ? 'bg-accent-lineage/10 border-accent-lineage/20 text-accent-lineage' : 'border-glass-border text-ink-muted')}>
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink">{label}</span>
                  <span className="block text-xs text-ink-muted">{desc}</span>
                </span>
                <span className={cn('w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center', active ? 'border-accent-lineage bg-accent-lineage' : 'border-ink-muted/30')}>
                  {active && <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={handleSave}
          disabled={saving || !dirty || !name.trim()}
          className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 bg-gradient-to-r from-accent-lineage to-violet-600 text-white text-sm font-semibold shadow-lg shadow-accent-lineage/25 hover:shadow-xl hover:-translate-y-0.5 disabled:opacity-50 disabled:shadow-none disabled:translate-y-0 disabled:cursor-not-allowed transition-all duration-200"
        >
          <Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button
          onClick={onCancel}
          disabled={saving}
          className="px-4 py-2.5 rounded-xl border border-glass-border text-sm font-medium text-ink-muted hover:text-ink transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
