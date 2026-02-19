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
  Database,
  ChevronsUpDown,
  Check
} from 'lucide-react'
import { useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { usePreferencesStore } from '@/store/preferences'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { ViewSelector } from '@/components/views/ViewSelector'
import { useViewEditorModal } from './AppShell'
import { WorkspacePanel } from '@/components/workspaces/WorkspacePanel'
import { ConnectionsPanel } from '@/components/connections/ConnectionsPanel'
import { useWorkspaces } from '@/hooks/useWorkspaces'
import { useConnections } from '@/hooks/useConnections'
import { cn } from '@/lib/utils'

interface NavItem {
  id: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  badge?: number
}

const mainNavItems: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'explore', label: 'Explore', icon: Network },
  { id: 'lenses', label: 'Context Lenses', icon: Layers },
  { id: 'schema', label: 'Schema Editor', icon: Palette },
]

function EnvironmentSwitcher({
  onManageWorkspaces,
  onManageConnections,
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

  const {
    connections,
    activeConnectionId,
    setActiveConnection
  } = useConnections()

  const activeConnection = connections.find(c => c.id === activeConnectionId)
  const activeDs = activeWorkspace?.dataSources?.find(d => d.id === activeDataSourceId)

  let displayName = "Select Environment"
  let displaySub = "No selection"
  let Icon = Database

  if (activeWorkspace) {
    displayName = activeWorkspace.name
    displaySub = activeDs ? (activeDs.label || activeDs.graphName || 'Workspace') : 'Workspace'
    Icon = Database
  } else if (activeConnection) {
    displayName = activeConnection.name
    displaySub = 'Legacy Connection'
    Icon = Network
  }

  if (collapsed) {
    return (
      <div className="p-3 flex justify-center border-b border-glass-border">
        <button
          onClick={onManageWorkspaces}
          className="w-10 h-10 rounded-xl bg-accent-business/10 flex items-center justify-center text-accent-business border border-accent-business/20 cursor-pointer hover:bg-accent-business/20 transition-colors"
          title={displayName}
        >
          <Icon className="w-5 h-5" />
        </button>
      </div>
    )
  }

  return (
    <div className="px-3 pt-3 pb-2 border-b border-glass-border mb-2">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className={cn(
            "w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-left",
            "bg-gradient-to-br from-black/5 to-black/10 dark:from-white/5 dark:to-white/10",
            "border border-glass-border shadow-[0_2px_8px_-2px_rgba(0,0,0,0.1)] hover:shadow-[0_4px_12px_-2px_rgba(0,0,0,0.15)]",
            "transition-all duration-200 group outline-none focus:ring-2 focus:ring-accent-business/50"
          )}>
            <div className="flex items-center gap-3 overflow-hidden">
              <div className="w-8 h-8 rounded-lg bg-accent-business/20 flex items-center justify-center text-accent-business border border-accent-business/30 shrink-0 shadow-inner">
                <Icon className="w-4 h-4" />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-semibold text-ink truncate leading-tight">{displayName}</span>
                <span className="text-[10px] text-ink-muted truncate mt-0.5">{displaySub}</span>
              </div>
            </div>
            <ChevronsUpDown className="w-4 h-4 text-ink-muted group-hover:text-ink transition-colors shrink-0" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="w-64 bg-canvas-elevated border border-glass-border rounded-xl shadow-xl p-2 z-50 animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-2 ml-3"
            align="start"
            sideOffset={8}
          >
            {/* Workspaces Group */}
            <div className="px-3 py-1.5 mb-1 flex items-center justify-between">
              <span className="text-[10px] font-bold text-ink-muted uppercase tracking-wider">Workspaces</span>
              <button onClick={onManageWorkspaces} className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5" title="Manage Workspaces">
                <Plus className="w-3 h-3 text-ink-muted" />
              </button>
            </div>
            {workspaces.map(ws => (
              <div key={ws.id} className="flex flex-col mb-1">
                <DropdownMenu.Item
                  onSelect={() => setActiveWorkspace(ws.id)}
                  className="flex items-center justify-between px-3 py-2 text-sm text-ink-secondary rounded-lg hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer outline-none focus:bg-accent-business/10 focus:text-accent-business transition-colors"
                >
                  <div className="flex items-center gap-2 truncate">
                    <Database className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate font-medium">{ws.name}</span>
                  </div>
                  {ws.id === activeWorkspaceId && <Check className="w-4 h-4 text-emerald-500 shrink-0" />}
                </DropdownMenu.Item>

                {/* Data sources sub-options */}
                {(ws.id === activeWorkspaceId && ws.dataSources && ws.dataSources.length > 1) && (
                  <div className="mt-1 ml-6 flex flex-col gap-0.5 border-l-2 border-glass-border pl-2">
                    {ws.dataSources.map(ds => (
                      <div
                        key={ds.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveDataSource(ds.id);
                        }}
                        className={cn("flex items-center justify-between text-xs px-2 py-1.5 rounded cursor-pointer transition-colors",
                          ds.id === activeDataSourceId ? "text-accent-business bg-accent-business/5 font-medium" : "text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5")}
                      >
                        <span className="truncate flex-1 pr-2">{ds.label || ds.graphName || ds.providerId}</span>
                        {ds.id === activeDataSourceId && <Check className="w-3 h-3 text-accent-business shrink-0" />}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {workspaces.length === 0 && (
              <div onClick={onManageWorkspaces} className="px-3 py-2 text-xs text-ink-muted italic border border-dashed border-glass-border rounded-lg text-center cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink transition-colors mb-1">
                Create Workspace...
              </div>
            )}

            <DropdownMenu.Separator className="h-px bg-glass-border my-2 mx-1" />

            {/* Legacy Connections Group */}
            <div className="px-3 py-1.5 mb-1 flex items-center justify-between">
              <span className="text-[10px] font-bold text-ink-muted uppercase tracking-wider">Legacy Connections</span>
              <button onClick={onManageConnections} className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5" title="Manage Connections">
                <Plus className="w-3 h-3 text-ink-muted" />
              </button>
            </div>
            {connections.map(conn => (
              <DropdownMenu.Item
                key={conn.id}
                onSelect={() => setActiveConnection(conn.id)}
                className="flex items-center justify-between px-3 py-2 text-sm text-ink-secondary rounded-lg hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer outline-none focus:bg-accent-business/10 focus:text-accent-business transition-colors mb-1"
              >
                <div className="flex items-center gap-2 truncate">
                  <Network className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{conn.name}</span>
                </div>
                {conn.id === activeConnectionId && <Check className="w-4 h-4 text-emerald-500 shrink-0" />}
              </DropdownMenu.Item>
            ))}
            {connections.length === 0 && (
              <div onClick={onManageConnections} className="px-3 py-2 text-xs text-ink-muted italic border border-dashed border-glass-border rounded-lg text-center cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink transition-colors">
                Add Legacy Connection...
              </div>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  )
}

export function SidebarNav() {
  const { sidebarCollapsed, toggleSidebar } = usePreferencesStore()
  const activeLensId = useCanvasStore((s) => s.activeLensId)
  const schema = useSchemaStore((s) => s.schema)
  const { openViewEditor } = useViewEditorModal()

  const [showWorkspacePanel, setShowWorkspacePanel] = useState(false)
  const [showConnectionPanel, setShowConnectionPanel] = useState(false)

  // Get views from schema
  const savedViews = schema?.views ?? []
  const pinnedViews = savedViews.filter((v) => v.isDefault)

  // Entity types from schema for quick access
  // const entityTypes = schema?.entityTypes.slice(0, 5) ?? []

  // Handle view creation
  const handleCreateView = () => {
    openViewEditor()
  }

  // Handle view edit
  const handleEditView = (viewId: string) => {
    openViewEditor(viewId)
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
          onManageWorkspaces={() => setShowWorkspacePanel(true)}
          onManageConnections={() => setShowConnectionPanel(true)}
        />
        <div className="px-3 space-y-1">
          {mainNavItems.map((item) => (
            <NavButton
              key={item.id}
              item={item}
              collapsed={sidebarCollapsed}
              active={item.id === 'explore'}
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
                  <ViewButton key={view.id} view={view} isPinned />
                ))}
                {savedViews
                  .filter((v) => !v.isDefault)
                  .slice(0, 5)
                  .map((view) => (
                    <ViewButton key={view.id} view={view} />
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

      {/* Workspace Panel Modal */}
      {showWorkspacePanel && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-canvas-elevated border border-glass-border rounded-xl shadow-2xl max-h-[90vh] overflow-y-auto max-w-2xl w-full m-4 animate-in zoom-in-95 duration-200">
            <WorkspacePanel onClose={() => setShowWorkspacePanel(false)} />
          </div>
        </div>
      )}

      {/* Connections Panel Modal */}
      {showConnectionPanel && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-canvas-elevated border border-glass-border rounded-xl shadow-2xl max-h-[90vh] overflow-y-auto max-w-2xl w-full m-4 animate-in zoom-in-95 duration-200">
            <ConnectionsPanel onClose={() => setShowConnectionPanel(false)} />
          </div>
        </div>
      )}
    </aside>
  )
}

interface NavButtonProps {
  item: NavItem
  collapsed: boolean
  active?: boolean
}

function NavButton({ item, collapsed, active }: NavButtonProps) {
  const Icon = item.icon

  return (
    <button
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
}

function ViewButton({ view, isPinned }: ViewButtonProps) {
  return (
    <button
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left",
        "text-sm text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink",
        "transition-all duration-150"
      )}
    >
      <Bookmark className={cn(
        "w-4 h-4 flex-shrink-0",
        isPinned && "text-accent-lineage fill-accent-lineage"
      )} />
      <span className="truncate flex-1">{view.name}</span>
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

