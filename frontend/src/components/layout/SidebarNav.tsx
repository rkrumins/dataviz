import { useState, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  LayoutDashboard,
  Network,
  Layers,
  History,
  Plus,
  ChevronsUpDown,
  Check,
  Settings,
  Database,
  Search,
  Bookmark,
  ExternalLink,
  GitBranch,
  AlignLeft,
  List,
  LayoutGrid,
  Clock,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react'
import * as Popover from '@radix-ui/react-popover'
import { useNavigate, Link } from 'react-router-dom'
import { useNavigationStore, type NavigationTab } from '@/store/navigation'
import { usePreferencesStore } from '@/store/preferences'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { useWorkspacesStore } from '@/store/workspaces'

import { useViewEditorModal } from './AppLayout'
import { useWorkspaces } from '@/hooks/useWorkspaces'
import { useBookmarkedViews } from '@/hooks/useBookmarkedViews'
import { useRecentViews } from '@/hooks/useRecentViews'
import { cn } from '@/lib/utils'
import type { View } from '@/services/viewApiService'
import type { RecentViewEntry } from '@/hooks/useRecentViews'
import * as LucideIcons from 'lucide-react'

// ── Sidebar sizing constants ────────────────────────────────────────
const MIN_WIDTH = 220
const MAX_WIDTH = 400
const DEFAULT_WIDTH = 256 // matches old w-64
const COLLAPSED_WIDTH = 56  // matches old w-16

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
  { id: 'schema', label: 'Semantic Layers', icon: Layers },
  { id: 'admin', label: 'Administration', icon: Settings },
]

// ── Workspace Avatar Colors ─────────────────────────────────────────
const WS_COLORS = [
  'from-indigo-500 to-violet-500',
  'from-emerald-500 to-teal-500',
  'from-amber-500 to-orange-500',
  'from-rose-500 to-pink-500',
  'from-cyan-500 to-blue-500',
  'from-fuchsia-500 to-purple-500',
]
function wsColor(index: number) { return WS_COLORS[index % WS_COLORS.length] }

// Maps layout type → Lucide icon name
function layoutTypeIcon(viewType: string): string {
  const map: Record<string, string> = {
    graph: 'Network',
    hierarchy: 'GitBranch',
    tree: 'GitBranch',
    reference: 'Layers',
    'layered-lineage': 'AlignLeft',
    list: 'List',
    grid: 'LayoutGrid',
    timeline: 'Clock',
  }
  return map[viewType] ?? 'Layout'
}

function DynamicIcon({ name, className }: { name: string; className?: string }) {
  const IconComponent = (LucideIcons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[name]
  if (!IconComponent) return <LucideIcons.Layout className={className} />
  return <IconComponent className={className} />
}

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

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
}: {
  onManageWorkspaces: () => void,
  onManageConnections: () => void,
  collapsed: boolean,
  onToggleSidebar: () => void,
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
    navigate('/dashboard')
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

        {/* Hover tooltip with full workspace + data source details */}
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
                  placeholder="Search environments..."
                  autoFocus
                  className="w-full bg-transparent pl-8 pr-3 py-1.5 text-sm text-ink focus:outline-none placeholder:text-ink-muted"
                />
              </div>
            </div>

            <div className="max-h-[50vh] overflow-y-auto custom-scrollbar p-2 space-y-3">
              {filteredWorkspaces.map((ws, i) => {
                const isWsActive = ws.id === activeWorkspaceId
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
                    </div>

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

        {/* Collapse toggle — integrated into workspace row */}
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
// Workspace Views List
// ─────────────────────────────────────────────────────────────────────
interface WorkspaceViewsListProps {
  activeViewId: string | null
  bookmarkedIds: Set<string>
  onOpenView: (viewId: string) => void
  onCreateView: () => void
  onEditView: (viewId: string) => void
  onBookmark: (viewId: string) => void
}

function WorkspaceViewsList({ activeViewId, bookmarkedIds, onOpenView, onCreateView, onEditView, onBookmark }: WorkspaceViewsListProps) {
  useSchemaStore((s) => s.activeScopeKey)
  const visibleViews = useSchemaStore((s) => s.visibleViews)
  const views = visibleViews()

  if (views.length === 0) {
    return (
      <div className="px-3 py-2 mb-1">
        <p className="text-xs text-ink-muted leading-relaxed">
          No views in this workspace yet.{' '}
          <button
            onClick={onCreateView}
            className="text-accent-lineage hover:underline"
          >
            Create one
          </button>
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-0.5 mb-1">
      {views.map(view => {
        const isActive = view.id === activeViewId
        const isBookmarked = bookmarkedIds.has(view.id)
        return (
          <div
            key={view.id}
            role="button"
            tabIndex={0}
            onClick={() => onOpenView(view.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenView(view.id) } }}
            className={cn(
              "w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left group transition-colors duration-150 cursor-pointer",
              isActive
                ? "bg-accent-lineage/10 text-accent-lineage"
                : "text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink"
            )}
          >
            <DynamicIcon
              name={view.icon || layoutTypeIcon(view.layout?.type ?? 'graph')}
              className={cn("w-4 h-4 shrink-0", isActive ? "text-accent-lineage" : "text-ink-muted")}
            />
            <span className="text-sm font-medium truncate flex-1">{view.name}</span>
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              {!isBookmarked && (
                <button
                  onClick={(e) => { e.stopPropagation(); onBookmark(view.id) }}
                  className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                  title="Bookmark"
                >
                  <Bookmark className="w-3 h-3 text-ink-muted" />
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); onEditView(view.id) }}
                className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                title="Edit view"
              >
                <Settings className="w-3 h-3 text-ink-muted" />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Bookmark Item
// ─────────────────────────────────────────────────────────────────────
interface BookmarkItemProps {
  view: View
  isActive: boolean
  isCrossWorkspace: boolean
  onClick: () => void
  onRemoveBookmark: () => void
}

function BookmarkItem({ view, isActive, isCrossWorkspace, onClick, onRemoveBookmark }: BookmarkItemProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      className={cn(
        "w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left group transition-colors duration-150 cursor-pointer",
        isActive
          ? "bg-accent-lineage/10 text-accent-lineage"
          : "text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink"
      )}
    >
      <DynamicIcon
        name={view.config?.icon || layoutTypeIcon(view.viewType)}
        className={cn("w-4 h-4 shrink-0", isActive ? "text-accent-lineage" : "text-ink-muted")}
      />
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-sm font-medium truncate">{view.name}</span>
        {isCrossWorkspace && view.workspaceName && (
          <span className="text-[10px] text-ink-muted truncate leading-tight mt-0.5">
            {view.workspaceName}
          </span>
        )}
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onRemoveBookmark() }}
        className="opacity-0 group-hover:opacity-100 p-1 rounded transition-all hover:bg-black/10 dark:hover:bg-white/10 shrink-0"
        title="Remove bookmark"
      >
        <Bookmark className={cn(
          "w-3.5 h-3.5",
          isActive ? "text-accent-lineage fill-accent-lineage" : "text-ink-muted fill-current"
        )} />
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Bookmarks skeleton / empty state
// ─────────────────────────────────────────────────────────────────────
function BookmarksSkeleton() {
  return (
    <div className="space-y-1 px-3 py-1">
      {[1, 2, 3].map(i => (
        <div
          key={i}
          className="h-8 rounded-lg bg-black/5 dark:bg-white/5 animate-pulse"
          style={{ opacity: 1 - (i - 1) * 0.25 }}
        />
      ))}
    </div>
  )
}

function BookmarksEmptyState() {
  return (
    <div className="px-3 py-3">
      <p className="text-xs text-ink-muted leading-relaxed">
        Bookmark views from the{' '}
        <Link to="/explorer" className="text-accent-lineage hover:underline">
          Explorer
        </Link>
        {' '}for quick access.
      </p>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Recent view item
// ─────────────────────────────────────────────────────────────────────
interface RecentItemProps {
  entry: RecentViewEntry
  isActive: boolean
  isBookmarked: boolean
  onClick: () => void
  onBookmark: () => void
}

function RecentItem({ entry, isActive, isBookmarked, onClick, onBookmark }: RecentItemProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      className={cn(
        "w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left group transition-colors duration-150 cursor-pointer",
        isActive
          ? "bg-accent-lineage/10 text-accent-lineage"
          : "text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink"
      )}
    >
      <History className="w-4 h-4 shrink-0 text-ink-muted" />
      <span className="text-sm truncate flex-1">{entry.viewName}</span>
      <div className="flex items-center gap-1 shrink-0">
        {!isBookmarked && (
          <button
            onClick={(e) => { e.stopPropagation(); onBookmark() }}
            className="opacity-0 group-hover:opacity-100 p-1 rounded transition-all hover:bg-black/10 dark:hover:bg-white/10"
            title="Add to bookmarks"
          >
            <Bookmark className="w-3 h-3 text-ink-muted" />
          </button>
        )}
        <span className="text-[10px] text-ink-muted opacity-0 group-hover:opacity-100 transition-opacity">
          {formatRelativeTime(entry.visitedAt)}
        </span>
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
      {/* Active indicator bar when collapsed */}
      {active && collapsed && (
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-accent-lineage" />
      )}
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

// ─────────────────────────────────────────────────────────────────────
// Main SidebarNav
// ─────────────────────────────────────────────────────────────────────
export function SidebarNav() {
  const navigate = useNavigate()
  const { activeTab } = useNavigationStore()
  const { sidebarCollapsed, toggleSidebar } = usePreferencesStore()
  const activeLensId = useCanvasStore((s) => s.activeLensId)
  const { openViewEditor } = useViewEditorModal()
  const { activeWorkspaceId } = useWorkspaces()

  const activeViewId = useSchemaStore((s) => s.activeViewId)
  const setActiveView = useSchemaStore((s) => s.setActiveView)

  const { bookmarks, isLoading: isLoadingBookmarks, toggleBookmark } = useBookmarkedViews()
  const { recent } = useRecentViews()

  const bookmarkedIds = new Set(bookmarks.map(b => b.id))

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

  const handleCreateView = () => openViewEditor()
  const handleEditView = (viewId: string) => openViewEditor(viewId)

  const handleOpenView = (viewId: string, viewWorkspaceId?: string) => {
    if (viewWorkspaceId && viewWorkspaceId !== activeWorkspaceId) {
      useWorkspacesStore.getState().setActiveWorkspace(viewWorkspaceId)
    }
    setActiveView(viewId)
    navigate(`/views/${viewId}`)
  }

  const handleNavClick = (tabId: NavigationTab) => {
    switch (tabId) {
      case 'dashboard': navigate('/dashboard'); break
      case 'explore': navigate('/explorer'); break
      case 'lenses': navigate(activeWorkspaceId ? `/workspaces/${activeWorkspaceId}` : '/dashboard'); break
      case 'schema': navigate('/schema'); break
      case 'admin': navigate('/admin/overview'); break
    }
  }

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
          onManageWorkspaces={() => navigate('/admin/registry?tab=workspaces')}
          onManageConnections={() => navigate('/admin/registry?tab=connections')}
          onToggleSidebar={toggleSidebar}
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

        {/* ── VIEWS section (expanded only) ── */}
        {!sidebarCollapsed && (
          <div className="pt-4">
            <div className="flex items-center justify-between px-3 py-1 mb-1">
              <span className="text-xs font-medium text-ink-muted uppercase tracking-wider">Views</span>
              <button
                onClick={handleCreateView}
                className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                title="Create new view"
              >
                <Plus className="w-3 h-3 text-ink-muted" />
              </button>
            </div>

            <WorkspaceViewsList
              activeViewId={activeViewId}
              bookmarkedIds={bookmarkedIds}
              onOpenView={handleOpenView}
              onCreateView={handleCreateView}
              onEditView={handleEditView}
              onBookmark={(viewId) => toggleBookmark(viewId, false)}
            />

            {/* Bookmarks */}
            <div className="mt-3">
              <div className="flex items-center justify-between px-3 py-1">
                <span className="text-xs font-medium text-ink-muted uppercase tracking-wider">
                  Bookmarks{bookmarks.length > 0 ? ` (${bookmarks.length})` : ''}
                </span>
                <Link
                  to="/explorer"
                  className="flex items-center gap-1 text-[10px] text-ink-muted hover:text-ink-secondary transition-colors"
                  title="Browse all views in Explorer"
                >
                  Explorer <ExternalLink className="w-2.5 h-2.5" />
                </Link>
              </div>

              {isLoadingBookmarks ? (
                <BookmarksSkeleton />
              ) : bookmarks.length === 0 ? (
                <BookmarksEmptyState />
              ) : (
                <div className="space-y-0.5">
                  {bookmarks.map(view => (
                    <BookmarkItem
                      key={view.id}
                      view={view}
                      isActive={view.id === activeViewId}
                      isCrossWorkspace={view.workspaceId !== activeWorkspaceId}
                      onClick={() => handleOpenView(view.id, view.workspaceId)}
                      onRemoveBookmark={() => toggleBookmark(view.id, true)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Recent */}
            {recent.length > 0 && (
              <div className="mt-3">
                <div className="px-3 py-1">
                  <span className="text-xs font-medium text-ink-muted uppercase tracking-wider">Recent</span>
                </div>
                <div className="space-y-0.5">
                  {recent.map(entry => (
                    <RecentItem
                      key={entry.viewId}
                      entry={entry}
                      isActive={entry.viewId === activeViewId}
                      isBookmarked={bookmarkedIds.has(entry.viewId)}
                      onClick={() => handleOpenView(entry.viewId, entry.workspaceId)}
                      onBookmark={() => toggleBookmark(entry.viewId, false)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Collapsed: bookmark count badge */}
        {sidebarCollapsed && (
          <div className="px-1.5 py-2 flex justify-center mt-2">
            <button
              title={bookmarks.length > 0 ? `${bookmarks.length} bookmark${bookmarks.length !== 1 ? 's' : ''}` : 'No bookmarks yet — browse Explorer'}
              onClick={() => navigate('/explorer')}
              className="relative w-9 h-9 rounded-lg flex items-center justify-center text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              <Bookmark className="w-5 h-5" />
              {bookmarks.length > 0 && (
                <span className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-accent-lineage text-[9px] text-white flex items-center justify-center font-bold leading-none">
                  {bookmarks.length > 9 ? '9+' : bookmarks.length}
                </span>
              )}
            </button>
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

// Keep unused icon imports referenced to avoid tree-shaking warnings
// (GitBranch, AlignLeft, List, LayoutGrid, Clock are used via layoutTypeIcon + DynamicIcon)
void [GitBranch, AlignLeft, List, LayoutGrid, Clock, History]
