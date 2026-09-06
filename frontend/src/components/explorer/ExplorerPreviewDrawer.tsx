/**
 * ExplorerPreviewDrawer — Slide-in side panel for quick-previewing a view.
 *
 * Two accounts, deliberately separate. WHAT THIS VIEW RESTS ON is the shared
 * `ViewBuiltOn` chain — workspace, data source, graph provider, semantic layer,
 * drawn as one stack with the provider's live health and the ontology's version
 * on it. THE VIEW RECORD is everything else: type, layout, description, tags,
 * authorship, dates, usage, and a preview of its layers.
 *
 * Those first four used to be two flat rows here plus two pills up top, each
 * naming a fact and none of them saying the four were a stack. The chain is the
 * same component the view's own details sheet renders, so the two surfaces
 * cannot drift about what a view is built on.
 */
import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { History, Settings2 } from 'lucide-react'
import { ViewActivityDrawer } from '@/components/views/ViewActivityDrawer'
// Extracted so the full-canvas ViewPage can host the same form. One component,
// two hosts — not two forms that drift.
import { EditDetailsPanel } from '@/components/views/EditDetailsPanel'
import { ViewUsageDetails } from './ViewUsage'
import { ViewBuiltOn } from '@/components/views/ViewBuiltOn'
import { useViewUsage } from '@/hooks/useContentInsights'
import { Link } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { MOTION } from '@/lib/motion'
import {
  X,
  Share2,
  Trash2,
  Tag,
  Calendar,
  ExternalLink,
  Pencil,
  RefreshCw,
  LayoutDashboard,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { CreatorHoverCard } from './CreatorHoverCard'
import { VISIBILITY_ICON, visibilityDescription, visibilityLabel } from '@/lib/viewVisibility'
import { timeAgo } from '@/lib/timeAgo'
import { DynamicIcon, resolveViewIcon, viewTypeMeta, viewTypeLabel } from '@/lib/viewUtils'
import type { View } from '@/services/viewApiService'
import { Backdrop } from '@/components/ui/Backdrop'
import type { ViewLayerConfig } from '@/types/schema'

// ─── Types ──────────────────────────────────────────────────────

interface ExplorerPreviewDrawerProps {
  view: View | null
  isOpen: boolean
  onClose: () => void
  onShare: () => void
  /** Opens the full builder (ViewWizard) — labelled "Edit layout & scope". */
  onEdit?: () => void
  editDisabled?: boolean
  onDelete?: () => void
  healthStatus?: 'healthy' | 'warning' | 'broken' | 'stale'
  /** Open directly in details-edit mode (used when the pencil is clicked). */
  initialEditMode?: boolean
  /** Called after a successful details save so the host can refetch. */
  onSaved?: () => void
}

// ─── Constants ──────────────────────────────────────────────────

// Data from the shared module — see lib/viewVisibility.
const VISIBILITY_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  private: { label: visibilityLabel('private'), icon: VISIBILITY_ICON.private },
  workspace: { label: visibilityLabel('workspace'), icon: VISIBILITY_ICON.workspace },
  enterprise: { label: visibilityLabel('enterprise'), icon: VISIBILITY_ICON.enterprise },
}

// View type theme comes from the SHARED resolver — see viewTypeMeta() /
// viewTypeLabel() in lib/viewUtils. No local map (that duplication is what let
// the recents strip render a different icon+colour for the same view).

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
              {/* Layer body.
                  NO DESCRIPTION HERE. Two lines of prose per layer, across a
                  seven-layer row, was the tallest thing in the tallest block of
                  a panel that had to be scrolled to reach its own buttons — and
                  it is the least useful part of a preview, where the question
                  is "which layers does this view have", not "what does each one
                  mean". The full text is on the layer itself, one click away in
                  the view; the name carries it on hover here. */}
              <div className="px-2.5 py-2 space-y-1.5" title={layer.description || undefined}>
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
  onShare,
  onEdit,
  editDisabled,
  onDelete,
  healthStatus,
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

  // Only while the drawer is actually open, and only for the one view it is
  // showing. The shelf behind it already batched its own; this is a single id
  // and would otherwise fire for every card the mouse passed over.
  // Hoisted out of the dependency array: an optional chain in there makes
  // the React Compiler bail on memoizing the whole component.
  const viewId = view?.id
  const usageIds = useMemo(() => (viewId ? [viewId] : []), [viewId])
  const { data: usageMap } = useViewUsage(usageIds, isOpen)
  const usage = viewId ? usageMap?.[viewId] : undefined
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

      {/* No AnimatePresence: this portaled popover unmounts instantly on close so an interrupted exit can't strand an invisible click-blocker over the page. It still animates in. */}
      <>
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
            transition={MOTION.drawerSlide}
          >
            {/* ── Header ── */}
            <div className="flex items-start justify-between gap-3 px-6 pt-6 pb-5 border-b border-glass-border/50">
              <div className="flex-1 min-w-0">
                {/* WHAT IT IS, AND WHO CAN SEE IT, on one line. Visibility used
                    to hold a band of its own at the top of the body — a single
                    small chip with a whole row's height and margin to itself,
                    on a panel that had to be scrolled to reach its buttons. It
                    belongs beside the type: both answer "what am I looking at"
                    before any detail about it. */}
                <div className="flex items-center gap-2 flex-wrap mb-3">
                  {(() => {
                    const typeMeta = viewTypeMeta(view.viewType)
                    // Glyph = the user's chosen icon when set; pill color stays type identity.
                    const iconName = resolveViewIcon({ icon: view.config?.icon, viewType: view.viewType })
                    return (
                      <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold', typeMeta.iconBg)}>
                        <DynamicIcon name={iconName} className="h-3 w-3" />
                        {/* No " View" suffix — the labels are already nouns, and
                            appending it rendered "Context View View". */}
                        {typeMeta.label}
                      </span>
                    )
                  })()}
                  {(() => {
                    const vis = VISIBILITY_META[view.visibility] ?? VISIBILITY_META.private
                    const VisIcon = vis.icon
                    return (
                      <HoverTip
                        label={`Visibility · ${vis.label}`}
                        detail={visibilityDescription(view.visibility, {
                          workspaceName: view.workspaceName ?? undefined,
                        })}
                      >
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-black/[0.04] dark:bg-white/[0.06] px-2.5 py-1 text-[11px] font-medium text-ink-muted">
                          <VisIcon className="h-3 w-3" />
                          {vis.label}
                        </span>
                      </HoverTip>
                    )
                  })()}
                </div>
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
                <EditDetailsPanel view={view} onCancel={() => setEditMode(false)} onSaved={onSaved} onEditLayout={onEdit} editDisabled={editDisabled} />
              ) : (
              <>
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
                    {/* "Reference model layers" is the schema's word for it,
                        not the reader's: `reference` is the internal viewType
                        that this app presents everywhere else as "Context
                        View". Derived from the same label resolver the header
                        pill uses, so the two can never drift apart. */}
                    <span className="text-[10px] uppercase tracking-widest font-bold text-ink-muted block mb-2">
                      {viewTypeMeta(view.viewType).label} layout preview
                      {layers.length > 0 && (
                        <span className="ml-1.5 text-ink-muted/50 normal-case tracking-normal">
                          ({layers.length} layers)
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

              {/* ── What this view is built on ──
                  The same chain the view's own details sheet renders, and for
                  the same reason: workspace → data source → graph provider →
                  semantic layer is a STACK, and drawing it as one says so.
                  This drawer used to print two of those four as flat rows
                  ("Semantic Layer: <name>", "Data Source: <name>") and the
                  other two only as pills up top, so the relationship between
                  them — the whole reason they belong on one panel — was left
                  for the reader to infer. The chain also carries what the rows
                  never could: the provider's live health, the ontology's
                  version and type counts, and when the source's data last
                  changed. Mounted with the drawer, so its two lookups stay off
                  the Explorer's list path. */}
              <ViewBuiltOn view={view} />

              {/* The view RECORD — what it is, who made it, when. What it
                  RESTS ON is the chain above; keeping the two apart is what
                  stopped this list being a bag of facts.
                  
                  FOLDED AWAY BY DEFAULT. Four rows of authorship and timestamps
                  is the least-read block on the panel and the last thing still
                  pushing the buttons below the fold on a QHD screen — but it is
                  also the block somebody occasionally needs exactly, so it
                  folds rather than goes. The summary carries the gist, so
                  collapsed is not the same as hidden: whoever only wanted to
                  know who made it and when never has to open it at all.
                  OPEN BY DEFAULT, now that the panel fits a screen without
                  scrolling: folding it was a way to buy back height, and once
                  the height is no longer needed, hiding facts behind a click
                  is a cost with nothing bought. It stays a disclosure so a
                  reader who does not want it can put it away — and so a future
                  addition to this panel has somewhere to give height back
                  from. Native <details>, like the chain's own disclosure —
                  keyboard reachable and correctly announced without JS. */}
              {/* WHO MADE IT IS THE ONE FACT WORTH A LINE UNCONDITIONALLY.
                  Folding the whole block away hid that too, and it is the
                  question this panel is opened for most often; showing all
                  four rows spent about 150px of a 1080px screen on
                  timestamps, which is what pushed the buttons below the fold.
                  So: the author stays, and the dates go behind one disclosure.
                  Native <details>, like the chain's own — keyboard reachable
                  and correctly announced without a line of JS. */}
              <div>
                <h4 className="text-[10px] uppercase tracking-widest font-bold text-ink-muted mb-3">
                  Details
                </h4>
                <div className="space-y-3">
                  {/* Created by — prefer the server-resolved display name;
                      fall back to "Unknown" when unresolvable — never the
                      raw id (kept in a title attr for debugging). Email
                      renders as a subtle secondary line so operators can
                      reach out without leaving the drawer. */}
                  {(view.createdByName || view.createdBy) && (
                    <CreatorHoverCard
                      userId={view.createdBy ?? null}
                      displayName={view.createdByName ?? null}
                      email={view.createdByEmail ?? null}
                    >
                      <div
                        tabIndex={0}
                        className="flex items-start gap-3 -mx-1 rounded-xl px-1 py-1 cursor-default transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                      >
                        {/* The person, not a generic glyph. `palette` is the
                            family every other Explorer creator surface uses
                            (the hover card, the card footer, the creator
                            filter), so one person is one swatch throughout. */}
                        <UserAvatar
                          userId={view.createdBy ?? null}
                          name={view.createdByName ?? 'Unknown'}
                          shape="palette"
                          className="w-9 h-9 text-[11px] font-bold ring-1 ring-black/[0.06] dark:ring-white/[0.08]"
                        />
                        <span className="flex flex-col min-w-0 flex-1">
                          <span className="text-[10px] uppercase tracking-widest font-bold text-ink-muted mb-0.5">
                            Created By
                          </span>
                          <span className="text-sm font-medium text-ink truncate" title={view.createdBy}>
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
                      </div>
                    </CreatorHoverCard>
                  )}


                  {/* THE DATES, BEHIND ONE DISCLOSURE. Four timestamp rows is
                      the least-read block on the panel and about 150px of a
                      1080px screen — the last thing pushing the buttons below
                      the fold. Whoever needs "when exactly" opens it; whoever
                      opened this panel to see who built the view already has
                      their answer above. */}
                  <details className="group/dates">
                    <summary className="flex cursor-pointer list-none items-center gap-1.5 -mx-1 rounded-lg px-1 py-1 text-[11px] font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.02] dark:hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                      <ChevronRight
                        aria-hidden
                        className="h-3.5 w-3.5 shrink-0 text-ink-muted transition-transform group-open/dates:rotate-90"
                      />
                      See all details
                      {/* The gist, so the fold costs nothing at a glance. */}
                      {view.updatedAt && (
                        <span className="ml-1 truncate font-normal text-ink-muted/70 group-open/dates:hidden">
                          updated {timeAgo(view.updatedAt)}
                        </span>
                      )}
                    </summary>
                    <div className="space-y-3 pt-3">
                  {/* THE TYPE IS ALREADY THE PILL BESIDE THE TITLE, and the
                      layout is the same word again on nearly every view — this
                      panel printed "Context View" three times in the top third
                      of itself, twice of that inside two large cards sitting
                      side by side. The pill keeps the type; the layout earns a
                      line only when it actually differs from it, which is the
                      only case where it tells the reader anything. */}
                  {(() => {
                    const layoutLabel = viewTypeLabel(view.config?.layout?.type)
                    const typeLabel = viewTypeMeta(view.viewType).label
                    if (!layoutLabel || layoutLabel === typeLabel) return null
                    return (
                      <DetailRow
                        icon={LayoutDashboard}
                        label="Layout"
                        value={layoutLabel}
                      />
                    )
                  })()}
                  {/* Created, and Updated only when it says something new. A
                      view nobody has edited since it was made carries the same
                      instant in both — this panel printed
                      "13 Jul 2026, 12:26 (1mo ago)" twice, on two rows, under
                      two different words. `Updated` earns its row when the view
                      has actually been edited since. */}
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

                  {/* The view's own settings/details edits (rename, layout,
                      description, tags). Distinct from "Data Updated" below. */}
                  {view.updatedAt && view.updatedAt !== view.createdAt && (
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
                            <span className="mt-0.5 flex items-center gap-1.5 min-w-0">
                              <UserAvatar
                                userId={view.updatedBy ?? null}
                                name={view.updatedByName}
                                shape="palette"
                                className="w-5 h-5 text-[8px] font-bold"
                              />
                              <span className="text-[11px] text-ink-muted truncate">by {view.updatedByName}</span>
                            </span>
                          )}
                        </span>
                      }
                    />
                  )}

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
                            <span className="mt-0.5 flex items-center gap-1.5 min-w-0">
                              <UserAvatar
                                userId={view.dataUpdatedBy ?? null}
                                name={view.dataUpdatedByName}
                                shape="palette"
                                className="w-5 h-5 text-[8px] font-bold"
                              />
                              <span className="text-[11px] text-ink-muted truncate">by {view.dataUpdatedByName}</span>
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-ink-muted">No published changes yet</span>
                      )
                    }
                  />
                    </div>
                  </details>
                </div>
              </div>

              {/* Usage — the question somebody opening a details panel is
                  actually asking about a view they do not recognise. */}
              {usage && (
                <div className="pt-3 border-t border-glass-border/50">
                  <span className="text-[10px] uppercase tracking-widest font-bold text-ink-muted block mb-1.5">
                    Usage
                  </span>
                  <ViewUsageDetails usage={usage} />
                </div>
              )}

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
      </>
    </>
  )

  // Render via portal to avoid z-index / overflow issues
  return createPortal(content, document.body)
}
