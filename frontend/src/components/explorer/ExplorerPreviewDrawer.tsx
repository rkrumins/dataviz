/**
 * ExplorerPreviewDrawer — Slide-in side panel for quick-previewing a view.
 *
 * Shows: view type, name, description, tags, workspace, visibility,
 * data source, semantic layer, layout, created/updated dates,
 * last synced, favourite count, and a mini preview for hierarchy/reference.
 */
import { Link } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X,
  Heart,
  Share2,
  Tag,
  Lock,
  Users,
  Globe,
  Calendar,
  User,
  ExternalLink,
  Network,
  GitBranch,
  Layout,
  Table2,
  Layers,
  Database,
  Box,
  RefreshCw,
  LayoutDashboard,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { workspaceColor } from '@/lib/workspaceColor'
import { timeAgo } from '@/lib/timeAgo'
import type { View } from '@/services/viewApiService'

// ─── Types ──────────────────────────────────────────────────────

interface ExplorerPreviewDrawerProps {
  view: View | null
  isOpen: boolean
  onClose: () => void
  onToggleFavourite: () => void
  onShare: () => void
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
  reference: { label: 'Reference', icon: Layout, color: 'bg-rose-500/10 border-rose-500/20 text-rose-500' },
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

function ReferencePreview() {
  return (
    <svg viewBox="0 0 280 100" className="w-full h-24 text-rose-500/25">
      {/* Grid of reference model cards */}
      {[0, 1, 2, 3].map(col => (
        <g key={`r1-${col}`}>
          <rect x={8 + col * 70} y={8} width={60} height={36} rx="4" fill="currentColor" opacity={1 - col * 0.15} />
          <line x1={14 + col * 70} y1={18} x2={56 + col * 70} y2={18} stroke="white" strokeWidth="1.5" opacity="0.4" />
          <line x1={14 + col * 70} y1={24} x2={46 + col * 70} y2={24} stroke="white" strokeWidth="1" opacity="0.25" />
          <line x1={14 + col * 70} y1={30} x2={52 + col * 70} y2={30} stroke="white" strokeWidth="1" opacity="0.15" />
        </g>
      ))}
      {[0, 1, 2].map(col => (
        <g key={`r2-${col}`}>
          <rect x={8 + col * 70} y={52} width={60} height={36} rx="4" fill="currentColor" opacity={0.7 - col * 0.15} />
          <line x1={14 + col * 70} y1={62} x2={56 + col * 70} y2={62} stroke="white" strokeWidth="1.5" opacity="0.4" />
          <line x1={14 + col * 70} y1={68} x2={46 + col * 70} y2={68} stroke="white" strokeWidth="1" opacity="0.25" />
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
}: ExplorerPreviewDrawerProps) {
  const content = (
    <AnimatePresence>
      {isOpen && view && (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 z-[60] bg-black/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />

          {/* Drawer panel */}
          <motion.aside
            className={cn(
              'fixed right-0 top-0 h-full w-[440px] max-w-[90vw] z-[61]',
              'bg-canvas border-l border-glass-border',
              'flex flex-col overflow-y-auto custom-scrollbar',
              'shadow-2xl',
            )}
            initial={{ x: 440 }}
            animate={{ x: 0 }}
            exit={{ x: 440 }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
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

            {/* ── Body ── */}
            <div className="flex-1 px-6 py-5 space-y-5">
              {/* Workspace + Visibility badges */}
              <div className="flex items-center gap-2 flex-wrap">
                {(() => {
                  const wsColor = workspaceColor(view.workspaceId)
                  return (
                    <span className={cn(
                      'inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold border',
                      wsColor.bg, wsColor.text, wsColor.border,
                    )}>
                      {view.workspaceName ?? view.workspaceId}
                    </span>
                  )
                })()}
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

              {/* Mini preview for hierarchy / reference */}
              {(view.viewType === 'hierarchy' || view.viewType === 'reference') && (
                <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-3 overflow-hidden">
                  <span className="text-[10px] uppercase tracking-widest font-bold text-ink-muted block mb-2">
                    Preview
                  </span>
                  {view.viewType === 'hierarchy' ? <HierarchyPreview /> : <ReferencePreview />}
                </div>
              )}

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
                      value={view.dataSourceId}
                    />
                  )}

                  {/* Created by */}
                  {view.createdBy && (
                    <DetailRow
                      icon={User}
                      label="Created By"
                      value={view.createdBy}
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

                  {/* Updated at */}
                  <DetailRow
                    icon={Calendar}
                    label="Updated"
                    value={
                      <span>
                        {formatDate(view.updatedAt)}
                        <span className="text-ink-muted text-xs ml-1.5">({timeAgo(view.updatedAt)})</span>
                      </span>
                    }
                  />

                  {/* Last synced (placeholder — using updatedAt for now) */}
                  <DetailRow
                    icon={RefreshCw}
                    label="Last Synced"
                    value={
                      <span>
                        {formatDate(view.updatedAt)}
                        <span className="text-ink-muted text-xs ml-1.5">({timeAgo(view.updatedAt)})</span>
                      </span>
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
            </div>

            {/* ── Footer actions ── */}
            <div className="flex items-center gap-3 px-6 py-5 border-t border-glass-border/50">
              <Link
                to={`/views/${view.id}`}
                className={cn(
                  'flex-1 inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3',
                  'bg-gradient-to-r from-accent-lineage to-violet-600 text-white text-sm font-semibold',
                  'shadow-lg shadow-accent-lineage/25',
                  'hover:shadow-xl hover:-translate-y-0.5',
                  'transition-[transform,box-shadow] duration-200',
                )}
              >
                <ExternalLink className="h-4 w-4" />
                Open Full View
              </Link>
              <button
                onClick={onShare}
                className={cn(
                  'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3',
                  'border border-glass-border text-sm font-medium text-ink-muted',
                  'bg-black/[0.02] dark:bg-white/[0.02]',
                  'hover:text-ink hover:border-glass-border/80 transition-colors duration-200',
                )}
              >
                <Share2 className="h-4 w-4" />
                Share
              </button>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )

  // Render via portal to avoid z-index / overflow issues
  return createPortal(content, document.body)
}
