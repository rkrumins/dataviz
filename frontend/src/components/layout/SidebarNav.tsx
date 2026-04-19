import { useState, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  LayoutDashboard,
  Network,
  Boxes,
  DatabaseZap,
  Layers,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Clock,
  ArrowRight,
  BookOpen,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useNavigationStore, type NavigationTab } from '@/store/navigation'
import { usePreferencesStore } from '@/store/preferences'
import { useCanvasStore } from '@/store/canvas'
import { useWorkspaceContext } from '@/hooks/useWorkspaceContext'
import { cn } from '@/lib/utils'
import { DynamicIcon, layoutTypeIcon, viewTypeColor } from '@/lib/viewUtils'

// ── Sidebar sizing constants ────────────────────────────────────────
const MIN_WIDTH = 220
const MAX_WIDTH = 400
const DEFAULT_WIDTH = 256
const COLLAPSED_WIDTH = 56

interface NavItem {
  id: NavigationTab
  label: string
  icon: React.ComponentType<{ className?: string }>
  badge?: number
}

const baseNavItems: Omit<NavItem, 'badge'>[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'explore', label: 'Explore', icon: Network },
  { id: 'workspaces', label: 'Workspaces', icon: Boxes },
  { id: 'ingestion', label: 'Ingestion', icon: DatabaseZap },
  { id: 'schema', label: 'Semantic Layers', icon: Layers },
  { id: 'admin', label: 'Administration', icon: Settings },
]

// ── Portal-based tooltip (escapes overflow:hidden) ──────────────────
function CollapsedTooltip({
  anchorRef,
  visible,
  children,
}: {
  anchorRef: React.RefObject<HTMLElement | null>
  visible: boolean
  children: React.ReactNode
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!visible || !anchorRef.current) { setPos(null); return }
    const rect = anchorRef.current.getBoundingClientRect()
    setPos({
      top: rect.top + rect.height / 2,
      left: rect.right + 10,
    })
  }, [visible, anchorRef])

  if (!visible || !pos) return null
  return createPortal(
    <div
      className="fixed z-[9999] pointer-events-none animate-in fade-in duration-150"
      style={{ top: pos.top, left: pos.left, transform: 'translateY(-50%)' }}
    >
      <div className="bg-canvas-elevated border border-glass-border rounded-xl shadow-xl px-3.5 py-2.5 min-w-[160px] max-w-[280px]">
        {children}
      </div>
    </div>,
    document.body,
  )
}

// ─────────────────────────────────────────────────────────────────────
// Sidebar Quick Access — Pinned + Recent sections
// ─────────────────────────────────────────────────────────────────────

function SidebarQuickAccess({
  onOpenView,
}: {
  onOpenView: (viewId: string, wsId?: string, dsId?: string) => void
}) {
  const navigate = useNavigate()
  const { pinnedViewIds, unpinView } = usePreferencesStore()
  const { recentViews, allViews, activeViewId } = useWorkspaceContext()

  // Resolve pinned view IDs to view data (filter out deleted views)
  const pinnedViews = pinnedViewIds
    .map(id => allViews.find(v => v.id === id))
    .filter((v): v is NonNullable<typeof v> => v != null)

  // Recent views that aren't already pinned, max 3
  const pinnedSet = new Set(pinnedViewIds)
  const recentNonPinned = recentViews
    .filter(r => !pinnedSet.has(r.viewId))
    .slice(0, 3)

  const hasContent = pinnedViews.length > 0 || recentNonPinned.length > 0

  if (!hasContent) {
    return (
      <div className="px-3 mt-4">
        <p className="text-[11px] text-ink-muted px-2 leading-relaxed">
          Pin views for quick access. Open any view and click the pin icon, or browse the{' '}
          <button
            onClick={() => navigate('/explorer')}
            className="text-accent-lineage hover:underline"
          >
            Explorer
          </button>.
        </p>
      </div>
    )
  }

  return (
    <div className="px-3 mt-4 space-y-3">
      {/* Pinned section */}
      {pinnedViews.length > 0 && (
        <div>
          <h3 className="px-2 mb-1 text-[10px] font-bold uppercase tracking-wider text-ink-muted flex items-center gap-1.5">
            <Pin className="w-3 h-3" />
            Pinned
          </h3>
          <div className="space-y-0.5">
            {pinnedViews.map(view => {
              const isActive = view.id === activeViewId
              const iconName = layoutTypeIcon(view.layout?.type ?? 'graph')
              const colorClass = viewTypeColor(view.layout?.type ?? 'graph')
              return (
                <div key={view.id} className="group flex items-center">
                  <button
                    onClick={() => onOpenView(view.id, view.workspaceId, view.dataSourceId ?? undefined)}
                    className={cn(
                      "flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors text-sm",
                      isActive
                        ? "bg-accent-lineage/10 text-accent-lineage"
                        : "text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink"
                    )}
                  >
                    <DynamicIcon
                      name={iconName}
                      className={cn("w-3.5 h-3.5 shrink-0", isActive ? "text-accent-lineage" : colorClass)}
                    />
                    <span className="truncate">{view.name}</span>
                  </button>
                  <button
                    onClick={() => unpinView(view.id)}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-all shrink-0"
                    title="Unpin"
                  >
                    <Pin className="w-3 h-3 text-ink-muted" />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Recent section */}
      {recentNonPinned.length > 0 && (
        <div>
          <h3 className="px-2 mb-1 text-[10px] font-bold uppercase tracking-wider text-ink-muted flex items-center gap-1.5">
            <Clock className="w-3 h-3" />
            Recent
          </h3>
          <div className="space-y-0.5">
            {recentNonPinned.map(entry => {
              const isActive = entry.viewId === activeViewId
              const iconName = layoutTypeIcon(entry.viewType)
              const colorClass = viewTypeColor(entry.viewType)
              return (
                <button
                  key={entry.viewId}
                  onClick={() => onOpenView(entry.viewId, entry.workspaceId, entry.dataSourceId)}
                  className={cn(
                    "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors text-sm",
                    isActive
                      ? "bg-accent-lineage/10 text-accent-lineage"
                      : "text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink"
                  )}
                >
                  <DynamicIcon
                    name={iconName}
                    className={cn("w-3.5 h-3.5 shrink-0", isActive ? "text-accent-lineage" : colorClass)}
                  />
                  <span className="truncate">{entry.viewName}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* See all link */}
      <div className="px-2">
        <button
          onClick={() => navigate('/explorer')}
          className="text-2xs text-ink-muted hover:text-accent-lineage transition-colors flex items-center gap-1"
        >
          Browse all views
          <ArrowRight className="w-2.5 h-2.5" />
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Nav button with tooltip support when collapsed
// ─────────────────────────────────────────────────────────────────────
interface NavButtonProps {
  item: NavItem
  collapsed: boolean
  active?: boolean
  onClick?: () => void
  onHoverStart?: (el: HTMLButtonElement) => void
  onHoverEnd?: () => void
}

function NavButton({ item, collapsed, active, onClick, onHoverStart, onHoverEnd }: NavButtonProps) {
  const Icon = item.icon

  return (
    <button
      onClick={onClick}
      onMouseEnter={collapsed ? (e) => onHoverStart?.(e.currentTarget) : undefined}
      onMouseLeave={collapsed ? () => onHoverEnd?.() : undefined}
      className={cn(
        "w-full flex items-center rounded-lg transition-all duration-150 relative",
        collapsed ? "justify-center p-2.5" : "gap-3 px-3 py-2.5",
        active
          ? "bg-accent-lineage/10 text-accent-lineage"
          : "text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink"
      )}
    >
      {active && collapsed && (
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-accent-lineage" />
      )}
      <Icon className="w-5 h-5 flex-shrink-0" />
      {!collapsed && (
        <>
          <span className="flex-1 text-left text-sm font-medium">{item.label}</span>
          {item.badge != null && item.badge > 0 && (
            <span className="px-1.5 py-0.5 text-2xs font-medium bg-accent-lineage/10 text-accent-lineage rounded">
              {item.badge}
            </span>
          )}
        </>
      )}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Main SidebarNav
// ─────────────────────────────────────────────────────────────────────
export function SidebarNav() {
  const navigate = useNavigate()
  const { activeTab } = useNavigationStore()
  const { sidebarCollapsed, toggleSidebar } = usePreferencesStore()
  const activeLensId = useCanvasStore((s) => s.activeLensId)

  const { viewCount, openView } = useWorkspaceContext()

  // ── Resize state ──────────────────────────────────────────────────
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const resizing = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(DEFAULT_WIDTH)

  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    if (sidebarCollapsed) return
    e.preventDefault()
    resizing.current = true
    startX.current = e.clientX
    startWidth.current = width
    const onMouseMove = (ev: MouseEvent) => {
      if (!resizing.current) return
      const delta = ev.clientX - startX.current
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + delta)))
    }
    const onMouseUp = () => {
      resizing.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [width, sidebarCollapsed])

  // ── Collapsed tooltip state ───────────────────────────────────────
  const [hoveredNavId, setHoveredNavId] = useState<string | null>(null)
  const hoveredNavRef = useRef<HTMLButtonElement | null>(null)

  const handleOpenView = (viewId: string, viewWorkspaceId?: string, viewDataSourceId?: string) => {
    openView(viewId, viewWorkspaceId, viewDataSourceId)
  }

  const handleNavClick = (tabId: NavigationTab) => {
    switch (tabId) {
      case 'dashboard': navigate('/dashboard'); break
      case 'explore': navigate('/explorer'); break
      case 'workspaces': navigate('/workspaces'); break
      case 'ingestion': navigate('/ingestion'); break
      case 'schema': navigate('/schema'); break
      case 'admin': navigate('/admin/overview'); break
    }
  }

  // Populate nav item badges
  const mainNavItems: NavItem[] = baseNavItems.map((item) => ({
    ...item,
    badge: item.id === 'explore' ? viewCount : undefined,
  }))

  const hoveredNavItem = hoveredNavId ? mainNavItems.find(i => i.id === hoveredNavId) : null

  return (
    <aside
      className="relative shrink-0 h-full z-40 bg-canvas-elevated border-r border-glass-border flex flex-col"
      style={{ width: sidebarCollapsed ? COLLAPSED_WIDTH : width, transition: resizing.current ? 'none' : 'width 200ms ease' }}
    >
      {/* Main Navigation */}
      <nav className="flex-1 flex flex-col overflow-y-auto custom-scrollbar pb-3">
        {/* Sidebar toggle */}
        <div className={cn(
          "flex items-center border-b border-glass-border",
          sidebarCollapsed ? "justify-center py-2.5" : "justify-end px-3 py-2.5"
        )}>
          <button
            onClick={toggleSidebar}
            className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed
              ? <PanelLeftOpen className="w-4.5 h-4.5" />
              : <PanelLeftClose className="w-5 h-5" />
            }
          </button>
        </div>

        {/* Primary nav items */}
        <div className={cn("space-y-0.5", sidebarCollapsed ? "px-1.5" : "px-3")}>
          {mainNavItems.map((item) => (
            <NavButton
              key={item.id}
              item={item}
              collapsed={sidebarCollapsed}
              active={activeTab === item.id}
              onClick={() => handleNavClick(item.id)}
              onHoverStart={(el) => { hoveredNavRef.current = el; setHoveredNavId(item.id) }}
              onHoverEnd={() => setHoveredNavId(null)}
            />
          ))}
        </div>

        {/* Pinned + Recent quick access (expanded sidebar only) */}
        {!sidebarCollapsed && (
          <SidebarQuickAccess
            onOpenView={handleOpenView}
          />
        )}
      </nav>

      {/* Active Lens Indicator */}
      {activeLensId && !sidebarCollapsed && (
        <div className="p-3 border-t border-glass-border">
          <div className="glass-panel-subtle rounded-lg p-3">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-accent-business animate-pulse" />
              <span className="text-xs font-medium text-ink-secondary">Active Lens</span>
            </div>
            <p className="text-sm font-medium mt-1 truncate">{activeLensId}</p>
          </div>
        </div>
      )}

      {/* Documentation link */}
      <div className={cn("border-t border-glass-border", sidebarCollapsed ? "px-1.5 py-2" : "px-3 py-2")}>
        <a
          href="/docs"
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "flex items-center rounded-lg transition-all duration-150 text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5",
            sidebarCollapsed ? "justify-center p-2.5" : "gap-2.5 px-3 py-2"
          )}
          title="Documentation"
        >
          <BookOpen className="w-4 h-4 shrink-0" />
          {!sidebarCollapsed && <span className="text-xs font-medium">Documentation</span>}
        </a>
      </div>

      {/* Resize handle (right edge) — only when expanded */}
      {!sidebarCollapsed && (
        <div
          onMouseDown={onResizeMouseDown}
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-indigo-500/30 active:bg-indigo-500/50 transition-colors z-10"
        />
      )}

      {/* Portal tooltip for collapsed nav items */}
      {sidebarCollapsed && hoveredNavItem && (
        <CollapsedTooltip anchorRef={hoveredNavRef} visible>
          <div className="flex items-center gap-2">
            <hoveredNavItem.icon className="w-4 h-4 text-accent-lineage" />
            <span className="text-sm font-semibold text-ink">{hoveredNavItem.label}</span>
          </div>
        </CollapsedTooltip>
      )}
    </aside>
  )
}
