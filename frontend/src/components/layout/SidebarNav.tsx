import { 
  LayoutDashboard, 
  Network, 
  Layers, 
  Bookmark, 
  History,
  ChevronLeft,
  ChevronRight,
  Plus,
  Settings,
  Palette
} from 'lucide-react'
import { usePreferencesStore } from '@/store/preferences'
import { useViewsStore } from '@/store/views'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { ViewSelector } from '@/components/views/ViewSelector'
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

export function SidebarNav() {
  const { sidebarCollapsed, toggleSidebar } = usePreferencesStore()
  const savedViews = useViewsStore((s) => s.views)
  const recentViewIds = useViewsStore((s) => s.recentViewIds)
  const activeLensId = useCanvasStore((s) => s.activeLensId)
  const schema = useSchemaStore((s) => s.schema)
  
  // Compute derived views client-side to avoid infinite loops
  const pinnedViews = savedViews.filter((v) => v.isPinned)
  const recentViews = recentViewIds
    .slice(0, 5)
    .map((id) => savedViews.find((v) => v.id === id))
    .filter((v): v is typeof savedViews[0] => v !== undefined)
  
  // Entity types from schema for quick access
  const entityTypes = schema?.entityTypes.slice(0, 5) ?? []

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
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto custom-scrollbar">
        {mainNavItems.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            collapsed={sidebarCollapsed}
            active={item.id === 'explore'}
          />
        ))}

        {/* View Selector */}
        {!sidebarCollapsed && (
          <div className="pt-4">
            <SectionHeader title="Active View" />
            <ViewSelector />
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
            <SectionHeader title="Saved Views" onAdd={() => {}} />
            {pinnedViews.length === 0 && recentViews.length === 0 ? (
              <p className="text-xs text-ink-muted px-3 py-2">
                No saved views yet
              </p>
            ) : (
              <div className="space-y-1">
                {pinnedViews.map((view) => (
                  <ViewButton key={view.id} view={view} isPinned />
                ))}
                {recentViews
                  .filter((v) => !v.isPinned)
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
  view: { id: string; name: string; lensId: string }
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

