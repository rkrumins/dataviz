import { useState, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  LayoutDashboard,
  Network,
  Boxes,
  DatabaseZap,
  Layers,
  ChevronsUpDown,
  Check,
  Settings,
  Database,
  Search,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Clock,
  ArrowRight,
  BookOpen,
} from 'lucide-react'
import * as Popover from '@radix-ui/react-popover'
import { useNavigate } from 'react-router-dom'
import { useNavigationStore, type NavigationTab } from '@/store/navigation'
import { usePreferencesStore } from '@/store/preferences'
import { useCanvasStore } from '@/store/canvas'
import { useWorkspaces } from '@/hooks/useWorkspaces'
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

// ── Workspace Avatar Colors (sidebar gradient variant) ──────────────
const WS_COLORS = [
  'from-indigo-500 to-violet-500',
  'from-emerald-500 to-teal-500',
  'from-amber-500 to-orange-500',
  'from-rose-500 to-pink-500',
  'from-cyan-500 to-blue-500',
  'from-fuchsia-500 to-purple-500',
]
function wsColor(index: number) { return WS_COLORS[index % WS_COLORS.length] }

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
// Environment Switcher
// ─────────────────────────────────────────────────────────────────────

function EnvironmentSwitcher({
  onManageWorkspaces,
  collapsed,
  onToggleSidebar,
  viewCountsByWorkspace,
  viewCountsByScope,
}: {
  onManageWorkspaces: () => void,
  collapsed: boolean,
  onToggleSidebar: () => void,
  viewCountsByWorkspace: Map<string, number>,
  viewCountsByScope: Map<string, number>,
}) {
  const navigate = useNavigate()
  const {
    workspaces,
    activeWorkspace,
    activeWorkspaceId,
    setActiveWorkspace,
    activeDataSourceId,
    setActiveDataSource
  } = useWorkspaces()

  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [wsHovered, setWsHovered] = useState(false)
  const wsButtonRef = useRef<HTMLButtonElement | null>(null)

  const activeDs = activeWorkspace?.dataSources?.find(d => d.id === activeDataSourceId)
  const activeIdx = workspaces.findIndex(ws => ws.id === activeWorkspaceId)

  const filteredWorkspaces = search
    ? workspaces.map(ws => {
      const matchWs = ws.name.toLowerCase().includes(search.toLowerCase())
      const matchDs = ws.dataSources?.filter(ds =>
        (ds.label || ds.catalogItemId).toLowerCase().includes(search.toLowerCase())
      )
      if (matchWs) return ws
      if (matchDs && matchDs.length > 0) return { ...ws, dataSources: matchDs }
      return null
    }).filter(Boolean) as typeof workspaces
    : workspaces

  const handleSelect = (wsId: string, dsId: string) => {
    setActiveWorkspace(wsId)
    setActiveDataSource(dsId)
    setIsOpen(false)
    setSearch('')
    navigate(`/explorer?workspace=${encodeURIComponent(wsId)}`)
  }

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1.5 py-2.5 border-b border-glass-border">
        <button
          onClick={onToggleSidebar}
          className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          title="Expand sidebar"
        >
          <PanelLeftOpen className="w-4.5 h-4.5" />
        </button>
        <button
          ref={wsButtonRef}
          onClick={() => setIsOpen(!isOpen)}
          onMouseEnter={() => setWsHovered(true)}
          onMouseLeave={() => setWsHovered(false)}
          className={cn(
            "w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold text-white border cursor-pointer transition-all",
            activeWorkspace
              ? `bg-gradient-to-br ${wsColor(activeIdx)} border-white/20 shadow-lg`
              : "bg-black/10 dark:bg-white/10 border-glass-border text-ink-muted"
          )}
        >
          {activeWorkspace ? activeWorkspace.name.charAt(0).toUpperCase() : '?'}
        </button>

        <CollapsedTooltip anchorRef={wsButtonRef} visible={wsHovered && !isOpen}>
          <div className="flex items-center gap-2.5">
            <div className={cn(
              "w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold shrink-0",
              activeWorkspace ? `bg-gradient-to-br ${wsColor(activeIdx)}` : "bg-black/10 dark:bg-white/10"
            )}>
              {activeWorkspace ? activeWorkspace.name.charAt(0).toUpperCase() : '?'}
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-semibold text-ink truncate">
                {activeWorkspace?.name || 'No workspace'}
              </span>
              <span className="text-xs text-ink-muted truncate flex items-center gap-1.5 mt-0.5">
                {activeDs && <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />}
                {activeDs ? (activeDs.label || 'Default Source') : 'No source selected'}
              </span>
            </div>
          </div>
        </CollapsedTooltip>
      </div>
    )
  }

  return (
    <div className="px-3 pt-3 pb-2 border-b border-glass-border mb-2">
      <div className="flex items-center gap-1.5">
        <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
          <Popover.Trigger asChild>
            <button className="group flex-1 min-w-0 flex items-center gap-3 p-2.5 rounded-xl bg-canvas hover:bg-canvas-elevated border border-transparent hover:border-glass-border transition-all text-left outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50">
              <div className={cn(
                "w-9 h-9 rounded-lg shadow-inner flex items-center justify-center text-white shrink-0 text-xs font-bold",
                activeWorkspace ? `bg-gradient-to-br ${wsColor(activeIdx)}` : "bg-black/10 dark:bg-white/10 text-ink-muted"
              )}>
                {activeWorkspace ? activeWorkspace.name.charAt(0).toUpperCase() : '?'}
              </div>
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-sm font-bold text-ink truncate leading-tight">
                  {activeWorkspace?.name || 'Select Workspace'}
                </span>
                <span className="text-xs text-ink-secondary truncate flex items-center gap-1.5 mt-0.5">
                  {activeDs && <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />}
                  {activeDs ? (activeDs.label || 'Default Source') : 'No source selected'}
                </span>
              </div>
              <ChevronsUpDown className="w-4 h-4 text-ink-muted opacity-50 group-hover:opacity-100 transition-opacity shrink-0" />
            </button>
          </Popover.Trigger>

        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="start"
            className="w-72 bg-canvas-elevated border border-glass-border rounded-xl shadow-2xl p-0 overflow-hidden z-50 animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-2 ml-3"
            sideOffset={4}
          >
            <div className="p-2 border-b border-glass-border bg-black/5 dark:bg-white/5">
              <div className="relative flex items-center">
                <Search className="absolute left-2.5 w-3.5 h-3.5 text-ink-muted" />
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search workspaces..."
                  autoFocus
                  className="w-full bg-transparent pl-8 pr-3 py-1.5 text-sm text-ink focus:outline-none placeholder:text-ink-muted"
                />
              </div>
            </div>

            <div className="max-h-[50vh] overflow-y-auto custom-scrollbar p-2 space-y-3">
              {filteredWorkspaces.map((ws, i) => {
                const isWsActive = ws.id === activeWorkspaceId
                const wsViewCount = viewCountsByWorkspace.get(ws.id) ?? 0
                return (
                  <div key={ws.id}>
                    <div className="px-2 pb-1.5 flex items-center gap-2">
                      <div className={cn(
                        "w-5 h-5 rounded overflow-hidden flex items-center justify-center text-[10px] font-bold text-white shrink-0",
                        `bg-gradient-to-br ${wsColor(i)}`
                      )}>
                        {ws.name.charAt(0).toUpperCase()}
                      </div>
                      <span className="text-xs font-bold text-ink tracking-wide truncate">{ws.name}</span>
                      {wsViewCount > 0 && (
                        <span className="text-2xs text-ink-muted ml-auto">
                          {wsViewCount} view{wsViewCount !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>

                    <div className="flex flex-col gap-0.5 ml-2 border-l-2 border-glass-border pl-1.5">
                      {ws.dataSources && ws.dataSources.map(ds => {
                        const isSelected = isWsActive && ds.id === activeDataSourceId
                        const scopeKey = `${ws.id}/${ds.id}`
                        const dsViewCount = viewCountsByScope.get(scopeKey) ?? 0
                        return (
                          <button
                            key={ds.id}
                            onClick={() => handleSelect(ws.id, ds.id)}
                            className={cn(
                              "flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer outline-none transition-colors text-left group",
                              isSelected
                                ? "bg-indigo-500/10 text-indigo-500"
                                : "text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                            )}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <Database className={cn("w-3.5 h-3.5 shrink-0", isSelected ? "text-indigo-500" : "text-ink-muted group-hover:text-ink")} />
                              <span className="text-sm font-medium truncate">{ds.label || 'Data Source'}</span>
                              {dsViewCount > 0 && (
                                <span className="text-2xs text-ink-muted">{dsViewCount}</span>
                              )}
                            </div>
                            {isSelected && <Check className="w-4 h-4 text-indigo-500 shrink-0 ml-2" />}
                          </button>
                        )
                      })}
                      {(!ws.dataSources || ws.dataSources.length === 0) && (
                        <button
                          onClick={() => { onManageWorkspaces(); setIsOpen(false) }}
                          className="px-3 py-2 text-xs text-ink-muted italic border border-dashed border-glass-border rounded-lg text-left hover:bg-black/5 dark:hover:bg-white/5 transition-colors focus-visible:outline-none"
                        >
                          No sources configured. Click to manage.
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
              {filteredWorkspaces.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-ink-muted">
                  {search ? 'No workspaces match your search' : 'No workspaces available'}
                </div>
              )}
            </div>

            <div className="p-2 border-t border-glass-border bg-black/5 dark:bg-white/5">
              <button
                onClick={() => { onManageWorkspaces(); setIsOpen(false) }}
                className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
              >
                <span className="flex items-center gap-1.5"><Settings className="w-3.5 h-3.5" /> Manage Workspaces</span>
                <span className="font-mono px-1 py-0.5 rounded bg-black/5 dark:bg-white/5 text-[9px]">⌘K</span>
              </button>
            </div>
          </Popover.Content>
        </Popover.Portal>
        </Popover.Root>

        <button
          onClick={onToggleSidebar}
          className="shrink-0 p-2 rounded-xl text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          title="Collapse sidebar"
        >
          <PanelLeftClose className="w-5 h-5" />
        </button>
      </div>
    </div>
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

  const { viewCount, viewCountsByWorkspace, viewCountsByScope, openView } = useWorkspaceContext()

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
        <EnvironmentSwitcher
          collapsed={sidebarCollapsed}
          onManageWorkspaces={() => navigate('/workspaces')}
          onToggleSidebar={toggleSidebar}
          viewCountsByWorkspace={viewCountsByWorkspace}
          viewCountsByScope={viewCountsByScope}
        />

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
