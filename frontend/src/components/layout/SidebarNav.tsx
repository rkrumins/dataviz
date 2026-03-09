import { useState } from 'react'
import {
  LayoutDashboard,
  Network,
  Layers,
  Bookmark,
  History,
  ChevronLeft,
  ChevronRight,
  Plus,
  Palette,
  ChevronsUpDown,
  Check,
  Star,
  Settings,
  Database,
  Search,
} from 'lucide-react'
import * as Popover from '@radix-ui/react-popover'
import { useNavigate } from 'react-router-dom'
import { useNavigationStore, type NavigationTab } from '@/store/navigation'
import { usePreferencesStore } from '@/store/preferences'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { ViewSelector } from '@/components/views/ViewSelector'
import { useViewEditorModal } from './AppLayout'
import { useWorkspaces } from '@/hooks/useWorkspaces'
import { cn } from '@/lib/utils'

interface NavItem {
  id: NavigationTab
  label: string
  icon: React.ComponentType<{ className?: string }>
  badge?: number
}

const mainNavItems: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'explore', label: 'Explore', icon: Network },
  { id: 'lenses', label: 'Context Lenses', icon: Layers },
  { id: 'schema', label: 'Schema Editor', icon: Palette },
  { id: 'admin' as any, label: 'Administration', icon: Settings },
]

// ─────────────────────────────────────────────────────────────────────
// Workspace Avatar Colors
// ─────────────────────────────────────────────────────────────────────
const WS_COLORS = [
  'from-indigo-500 to-violet-500',
  'from-emerald-500 to-teal-500',
  'from-amber-500 to-orange-500',
  'from-rose-500 to-pink-500',
  'from-cyan-500 to-blue-500',
  'from-fuchsia-500 to-purple-500',
]
function wsColor(index: number) { return WS_COLORS[index % WS_COLORS.length] }

// ─────────────────────────────────────────────────────────────────────
// Environment Switcher — Premium Workspace Toggle
// ─────────────────────────────────────────────────────────────────────

function EnvironmentSwitcher({
  onManageWorkspaces,
  collapsed
}: {
  onManageWorkspaces: () => void,
  onManageConnections: () => void,
  collapsed: boolean
}) {
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

  const activeDs = activeWorkspace?.dataSources?.find(d => d.id === activeDataSourceId)
  const activeIdx = workspaces.findIndex(ws => ws.id === activeWorkspaceId)

  // Filter logic: if search matches workspace name, include all its DS.
  // Otherwise, only include DS whose name/label matches the search.
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
  }

  if (collapsed) {
    return (
      <div className="p-3 flex justify-center border-b border-glass-border">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className={cn(
            "w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold text-white border cursor-pointer transition-all",
            activeWorkspace
              ? `bg-gradient-to-br ${wsColor(activeIdx)} border-white/20 shadow-lg`
              : "bg-black/10 dark:bg-white/10 border-glass-border text-ink-muted"
          )}
          title={activeWorkspace?.name || 'Select workspace'}
        >
          {activeWorkspace ? activeWorkspace.name.charAt(0).toUpperCase() : '?'}
        </button>
      </div>
    )
  }

  return (
    <div className="px-3 pt-3 pb-2 border-b border-glass-border mb-2">
      <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
        <Popover.Trigger asChild>
          <button className="group w-full flex items-center gap-3 p-2.5 rounded-xl bg-canvas hover:bg-canvas-elevated border border-transparent hover:border-glass-border transition-all text-left outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50">
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
            {/* ── Search Header ── */}
            <div className="p-2 border-b border-glass-border bg-black/5 dark:bg-white/5">
              <div className="relative flex items-center">
                <Search className="absolute left-2.5 w-3.5 h-3.5 text-ink-muted" />
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search environments..."
                  autoFocus
                  className="w-full bg-transparent pl-8 pr-3 py-1.5 text-sm text-ink focus:outline-none placeholder:text-ink-muted"
                />
              </div>
            </div>

            {/* ── Scrollable List ── */}
            <div className="max-h-[50vh] overflow-y-auto custom-scrollbar p-2 space-y-3">
              {filteredWorkspaces.map((ws, i) => {
                const isWsActive = ws.id === activeWorkspaceId
                return (
                  <div key={ws.id}>
                    {/* Workspace Label */}
                    <div className="px-2 pb-1.5 flex items-center gap-2">
                      <div className={cn(
                        "w-5 h-5 rounded overflow-hidden flex items-center justify-center text-[10px] font-bold text-white shrink-0",
                        `bg-gradient-to-br ${wsColor(i)}`
                      )}>
                        {ws.name.charAt(0).toUpperCase()}
                      </div>
                      <span className="text-xs font-bold text-ink tracking-wide truncate">{ws.name}</span>
                    </div>

                    {/* Data Sources */}
                    <div className="flex flex-col gap-0.5 ml-2 border-l-2 border-glass-border pl-1.5">
                      {ws.dataSources && ws.dataSources.map(ds => {
                        const isSelected = isWsActive && ds.id === activeDataSourceId
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
                  {search ? 'No environments match your search' : 'No workspaces available'}
                </div>
              )}
            </div>

            {/* ── Footer ── */}
            <div className="p-2 border-t border-glass-border bg-black/5 dark:bg-white/5">
              <button
                onClick={() => { onManageWorkspaces(); setIsOpen(false) }}
                className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
              >
                <span className="flex items-center gap-1.5"><Settings className="w-3.5 h-3.5" /> Manage Environments</span>
                <span className="font-mono px-1 py-0.5 rounded bg-black/5 dark:bg-white/5 text-[9px]">⌘K</span>
              </button>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}

export function SidebarNav() {
  const navigate = useNavigate()
  const { activeTab } = useNavigationStore()
  const { sidebarCollapsed, toggleSidebar } = usePreferencesStore()
  const activeLensId = useCanvasStore((s) => s.activeLensId)
  const visibleViews = useSchemaStore((s) => s.visibleViews)
  const { openViewEditor } = useViewEditorModal()
  const { activeWorkspaceId } = useWorkspaces()

  // Get views scoped to the active workspace+datasource (global/legacy views always included)
  const savedViews = visibleViews()
  const pinnedViews = savedViews.filter((v) => v.isDefault)

  const handleCreateView = () => {
    openViewEditor()
  }

  const handleEditView = (viewId: string) => {
    openViewEditor(viewId)
  }

  const setActiveView = useSchemaStore((s) => s.setActiveView)
  const updateView = useSchemaStore((s) => s.updateView)
  const activeViewId = useSchemaStore((s) => s.activeViewId)

  const handleOpenView = (viewId: string) => {
    setActiveView(viewId)
    navigate(`/views/${viewId}`)
  }

  const handleNavClick = (tabId: NavigationTab | string) => {
    switch (tabId) {
      case 'dashboard': navigate('/dashboard'); break
      case 'explore': navigate('/explorer'); break
      case 'lenses': navigate(activeWorkspaceId ? `/workspaces/${activeWorkspaceId}` : '/dashboard'); break
      case 'schema': navigate('/schema'); break
      case 'admin': navigate('/admin/overview'); break
    }
  }

  const handleTogglePin = (e: React.MouseEvent, viewId: string, currentIsDefault?: boolean) => {
    e.stopPropagation()
    updateView(viewId, { isDefault: !currentIsDefault })
  }

  return (
    <aside
      className={cn(
        "fixed left-0 top-14 bottom-0 z-40",
        "bg-canvas-elevated border-r border-glass-border",
        "flex flex-col transition-all duration-300",
        sidebarCollapsed ? "w-16" : "w-64"
      )}
    >
      {/* Main Navigation */}
      <nav className="flex-1 flex flex-col overflow-y-auto custom-scrollbar pb-3">
        <EnvironmentSwitcher
          collapsed={sidebarCollapsed}
          onManageWorkspaces={() => navigate('/admin/registry?tab=workspaces')}
          onManageConnections={() => navigate('/admin/registry?tab=connections')}
        />
        <div className="px-3 space-y-1">
          {mainNavItems.map((item) => (
            <NavButton
              key={item.id}
              item={item}
              collapsed={sidebarCollapsed}
              active={activeTab === item.id}
              onClick={() => handleNavClick(item.id)}
            />
          ))}
        </div>

        {/* View Selector */}
        {!sidebarCollapsed && (
          <div className="pt-2">
            <SectionHeader title="Active View" />
            <ViewSelector
              onCreateView={handleCreateView}
              onEditView={handleEditView}
            />
          </div>
        )}

        {/* Divider */}
        {!sidebarCollapsed && (
          <div className="pt-4 pb-2">
            <div className="h-px bg-glass-border" />
          </div>
        )}

        {/* Saved Views Section */}
        {!sidebarCollapsed && (
          <div className="pt-2">
            <SectionHeader title="Saved Views" onAdd={handleCreateView} />
            {savedViews.length === 0 ? (
              <p className="text-xs text-ink-muted px-3 py-2">
                No saved views yet
              </p>
            ) : (
              <div className="space-y-1">
                {pinnedViews.map((view) => (
                  <ViewButton
                    key={view.id}
                    view={view}
                    isPinned
                    isActive={view.id === activeViewId}
                    onClick={() => handleOpenView(view.id)}
                    onTogglePin={(e) => handleTogglePin(e, view.id, true)}
                  />
                ))}
                {savedViews
                  .filter((v) => !v.isDefault)
                  .slice(0, 5)
                  .map((view) => (
                    <ViewButton
                      key={view.id}
                      view={view}
                      isActive={view.id === activeViewId}
                      onClick={() => handleOpenView(view.id)}
                      onTogglePin={(e) => handleTogglePin(e, view.id, false)}
                    />
                  ))}
              </div>
            )}
          </div>
        )}

        {/* Recent Traces */}
        {!sidebarCollapsed && (
          <div className="pt-4">
            <SectionHeader title="Recent Traces" />
            <div className="space-y-1">
              <TraceItem label="Revenue → Sources" time="2m ago" />
              <TraceItem label="Customer Data Impact" time="1h ago" />
              <TraceItem label="Pipeline Dependencies" time="3h ago" />
            </div>
          </div>
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

      {/* Collapse Toggle */}
      <button
        onClick={toggleSidebar}
        className={cn(
          "absolute -right-3 top-6 z-50",
          "w-6 h-6 rounded-full bg-canvas-elevated border border-glass-border",
          "flex items-center justify-center",
          "hover:bg-accent-lineage hover:text-white hover:border-accent-lineage",
          "transition-all duration-150 shadow-sm"
        )}
      >
        {sidebarCollapsed ? (
          <ChevronRight className="w-3 h-3" />
        ) : (
          <ChevronLeft className="w-3 h-3" />
        )}
      </button>

      {/* Workspace Panel Modal — removed, management is now at /admin */}
    </aside>
  )
}

interface NavButtonProps {
  item: NavItem
  collapsed: boolean
  active?: boolean
  onClick?: () => void
}

function NavButton({ item, collapsed, active, onClick }: NavButtonProps) {
  const Icon = item.icon

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg",
        "transition-all duration-150",
        active
          ? "bg-accent-lineage/10 text-accent-lineage"
          : "text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink"
      )}
    >
      <Icon className="w-5 h-5 flex-shrink-0" />
      {!collapsed && (
        <>
          <span className="flex-1 text-left text-sm font-medium">{item.label}</span>
          {item.badge && (
            <span className="px-1.5 py-0.5 text-2xs font-medium bg-accent-lineage/20 text-accent-lineage rounded">
              {item.badge}
            </span>
          )}
        </>
      )}
    </button>
  )
}

interface SectionHeaderProps {
  title: string
  onAdd?: () => void
}

function SectionHeader({ title, onAdd }: SectionHeaderProps) {
  return (
    <div className="flex items-center justify-between px-3 py-1">
      <span className="text-xs font-medium text-ink-muted uppercase tracking-wider">
        {title}
      </span>
      {onAdd && (
        <button
          onClick={onAdd}
          className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5"
        >
          <Plus className="w-3 h-3 text-ink-muted" />
        </button>
      )}
    </div>
  )
}

interface ViewButtonProps {
  view: { id: string; name: string }
  isPinned?: boolean
  isActive?: boolean
  onClick?: () => void
  onTogglePin?: (e: React.MouseEvent) => void
}

function ViewButton({ view, isPinned, isActive, onClick, onTogglePin }: ViewButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-left group",
        "text-sm transition-all duration-150",
        isActive
          ? "bg-accent-lineage/10 text-accent-lineage font-medium"
          : "text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink"
      )}
    >
      <div className="flex items-center gap-2 truncate flex-1">
        <Bookmark className={cn(
          "w-4 h-4 flex-shrink-0 transition-colors",
          isPinned ? "text-accent-lineage fill-accent-lineage" : ""
        )} />
        <span className="truncate">{view.name}</span>
      </div>
      <div
        onClick={onTogglePin}
        className={cn(
          "p-1 rounded-md transition-all cursor-pointer",
          isPinned ? "opacity-100" : "opacity-0 group-hover:opacity-100 hover:bg-black/10 dark:hover:bg-white/10"
        )}
      >
        <Star className={cn("w-3.5 h-3.5", isPinned ? "text-amber-500 fill-amber-500" : "text-ink-muted")} />
      </div>
    </button>
  )
}

interface TraceItemProps {
  label: string
  time: string
}

function TraceItem({ label, time }: TraceItemProps) {
  return (
    <button
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left",
        "text-sm text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink",
        "transition-all duration-150"
      )}
    >
      <History className="w-4 h-4 flex-shrink-0 text-ink-muted" />
      <span className="truncate flex-1">{label}</span>
      <span className="text-2xs text-ink-muted">{time}</span>
    </button>
  )
}

