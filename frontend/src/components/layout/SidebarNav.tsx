import { useState, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  LayoutDashboard,
  Compass,
  Boxes,
  DatabaseZap,
  Layers,
  Shield,
  PanelLeftClose,
  PanelLeftOpen,
  BookOpen,
  Sparkles,
} from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { tabForPath, type NavigationTab } from '@/store/navigation'
import { usePreferencesStore } from '@/store/preferences'
import { useWorkspaceContext } from '@/hooks/useWorkspaceContext'
import { useIsClipped } from '@/hooks/useIsClipped'
import { cn } from '@/lib/utils'
import { useNavPermission } from '@/store/auth'
import { useSidebarSpec } from '@/store/navCatalogue'

// ── Sidebar sizing constants ────────────────────────────────────────
const MIN_WIDTH = 220
const MAX_WIDTH = 400
const DEFAULT_WIDTH = 256
const COLLAPSED_WIDTH = 56

interface NavItemColor {
  bg: string
  text: string
  border: string
  hoverBg: string
}

interface NavItemConfig {
  id: NavigationTab
  label: string
  icon: React.ComponentType<{ className?: string }>
  description: string
  color: NavItemColor
  badge?: number
}

const NAV_ITEMS_CONFIG: Omit<NavItemConfig, 'badge'>[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, description: 'Overview and workspace activity', color: { bg: 'bg-indigo-500/10', text: 'text-indigo-500', border: 'border-indigo-500/20', hoverBg: 'group-hover:bg-indigo-500/10' } },
  { id: 'explore', label: 'Explore', icon: Compass, description: 'Browse and open saved views', color: { bg: 'bg-violet-500/10', text: 'text-violet-500', border: 'border-violet-500/20', hoverBg: 'group-hover:bg-violet-500/10' } },
  { id: 'workspaces', label: 'Workspaces', icon: Boxes, description: 'Manage isolated data environments', color: { bg: 'bg-blue-500/10', text: 'text-blue-500', border: 'border-blue-500/20', hoverBg: 'group-hover:bg-blue-500/10' } },
  { id: 'ingestion', label: 'Ingestion', icon: DatabaseZap, description: 'Connect sources and import data', color: { bg: 'bg-emerald-500/10', text: 'text-emerald-500', border: 'border-emerald-500/20', hoverBg: 'group-hover:bg-emerald-500/10' } },
  { id: 'schema', label: 'Semantic Layers', icon: Layers, description: 'Define and manage ontology models', color: { bg: 'bg-amber-500/10', text: 'text-amber-500', border: 'border-amber-500/20', hoverBg: 'group-hover:bg-amber-500/10' } },
  { id: 'admin', label: 'Administration', icon: Shield, description: 'System settings, users, and health', color: { bg: 'bg-slate-500/10', text: 'text-slate-500', border: 'border-slate-500/20', hoverBg: 'group-hover:bg-slate-500/10' } },
]

/** How long a deliberate hover must last before a tooltip appears. Long enough
 *  that sweeping the pointer down the nav doesn't strobe six tooltips on the way
 *  past; short enough that stopping on a row feels instant. */
const TOOLTIP_DELAY_MS = 120

// ── Portal tooltip (escapes the sidebar's overflow) ─────────────────
/**
 * Deliberately CSS-animated and `pointer-events-none`. A portaled popover built
 * from `<AnimatePresence>` + an `exit` transition can strand an invisible
 * click-blocker across the app when its exit is interrupted — a freeze class
 * this codebase has already been bitten by three times. Plain mount/unmount plus
 * a CSS fade cannot leave anything behind.
 */
function SidebarTooltip({
  anchorRef,
  children,
}: {
  anchorRef: React.RefObject<HTMLElement | null>
  children: React.ReactNode
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    const el = anchorRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({ top: rect.top + rect.height / 2, left: rect.right + 10 })
  }, [anchorRef])

  if (!pos) return null
  return createPortal(
    <div
      role="tooltip"
      className="fixed z-[9999] pointer-events-none animate-in fade-in slide-in-from-left-1 duration-150"
      style={{ top: pos.top, left: pos.left, transform: 'translateY(-50%)' }}
    >
      <div className="bg-canvas-elevated border border-glass-border rounded-xl shadow-xl px-3.5 py-2.5 max-w-[280px]">
        {children}
      </div>
    </div>,
    document.body,
  )
}

// ─────────────────────────────────────────────────────────────────────
// Nav button with tooltip support when collapsed
// ─────────────────────────────────────────────────────────────────────
interface NavButtonProps {
  item: NavItemConfig
  collapsed: boolean
  active?: boolean
  onClick?: () => void
}

function NavButton({ item, collapsed, active, onClick }: NavButtonProps) {
  const Icon = item.icon
  const buttonRef = useRef<HTMLButtonElement>(null)
  const labelRef = useRef<HTMLSpanElement>(null)
  const descRef = useRef<HTMLSpanElement>(null)

  const labelClipped = useIsClipped(labelRef, !collapsed)
  const descClipped = useIsClipped(descRef, !collapsed)

  // The tooltip has something to say only when the row itself cannot show the
  // text: collapsed (no text rendered at all), or expanded with text the
  // ellipsis is eating. Otherwise hovering does nothing — by design.
  const hasHiddenText = collapsed || labelClipped || descClipped

  // Hover state lives HERE, not in the parent. It used to live in SidebarNav,
  // which meant every pointer movement across the nav re-rendered the whole
  // sidebar. Colocated, a hover re-renders exactly one row.
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const openTooltip = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current)
    openTimer.current = setTimeout(() => setTooltipOpen(true), TOOLTIP_DELAY_MS)
  }, [])
  const closeTooltip = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current)
    setTooltipOpen(false)
  }, [])
  useEffect(() => () => {
    if (openTimer.current) clearTimeout(openTimer.current)
  }, [])

  // Keyboard users get the reveal too — focus opens it, blur closes it. The
  // handlers are only attached when there is genuinely something hidden, so a
  // row that already reads in full has no hover behaviour to speak of.
  const reveal = hasHiddenText
    ? {
        onMouseEnter: openTooltip,
        onMouseLeave: closeTooltip,
        onFocus: openTooltip,
        onBlur: closeTooltip,
      }
    : {}

  return (
    <>
    <button
      ref={buttonRef}
      onClick={onClick}
      {...reveal}
      className={cn(
        "w-full flex items-center rounded-lg transition-all duration-150 relative group",
        collapsed ? "justify-center p-2" : "gap-3 px-2.5 py-2",
        active
          ? "bg-accent-lineage/8 text-ink"
          : "text-ink-secondary hover:bg-black/[0.03] dark:hover:bg-white/[0.03] hover:text-ink"
      )}
    >
      {/* Active indicator bar */}
      {active && (
        <div className={cn(
          "absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full bg-accent-lineage",
          collapsed ? "h-5" : "h-6"
        )} />
      )}

      {/* Icon with colored background */}
      <div className={cn(
        "flex items-center justify-center rounded-lg border shrink-0 transition-all duration-150",
        "w-8 h-8",
        item.color.text,
        active
          ? cn(item.color.bg, item.color.border)
          : cn("bg-transparent border-transparent", item.color.hoverBg)
      )}>
        <Icon className="w-4 h-4" />
      </div>

      {/* Label + Description + Badge (expanded only) */}
      {!collapsed && (
        <>
          <div className="flex-1 min-w-0 text-left">
            <span ref={labelRef} className="text-sm font-medium truncate block">{item.label}</span>
            <span ref={descRef} className="text-2xs text-ink-muted truncate block leading-tight">{item.description}</span>
          </div>
          {item.badge != null && item.badge > 0 && (
            <span className="px-1.5 py-0.5 text-2xs font-medium bg-accent-lineage/10 text-accent-lineage rounded shrink-0">
              {item.badge}
            </span>
          )}
        </>
      )}
    </button>

    {tooltipOpen && hasHiddenText && (
      <SidebarTooltip anchorRef={buttonRef}>
        <div className="flex items-center gap-2.5">
          {/* The icon is only worth repeating when it is all the user can see.
              Expanded, it is already sitting 10px to the left — showing it again
              would just make the tooltip heavier for no information. */}
          {collapsed && (
            <div className={cn(
              "w-7 h-7 rounded-lg border flex items-center justify-center shrink-0",
              item.color.bg, item.color.text, item.color.border
            )}>
              <Icon className="w-3.5 h-3.5" />
            </div>
          )}
          <div className="min-w-0">
            <span className="text-sm font-semibold text-ink block">{item.label}</span>
            {/* Wraps. The row truncates because it has one line; the tooltip has
                as many as it needs — that is the entire point of it existing. */}
            <span className="text-xs text-ink-muted block mt-0.5">{item.description}</span>
          </div>
        </div>
      </SidebarTooltip>
    )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Footer link (Guide / Docs)
// ─────────────────────────────────────────────────────────────────────
/**
 * Uses the same tooltip as the nav rows, replacing the native `title=` these
 * used to carry. A grey OS tooltip — different font, different timing, different
 * shape — appearing right next to the app's own glass one is exactly the kind of
 * seam that reads as unfinished. Expanded, these labels always fit, so there is
 * nothing to reveal and hovering does nothing.
 */
function SidebarFooterLink({
  href,
  label,
  icon: Icon,
  iconClass,
  collapsed,
  external,
}: {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  iconClass: string
  collapsed: boolean
  external?: boolean
}) {
  const linkRef = useRef<HTMLAnchorElement>(null)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const openTooltip = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current)
    openTimer.current = setTimeout(() => setTooltipOpen(true), TOOLTIP_DELAY_MS)
  }, [])
  const closeTooltip = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current)
    setTooltipOpen(false)
  }, [])
  useEffect(() => () => {
    if (openTimer.current) clearTimeout(openTimer.current)
  }, [])

  const reveal = collapsed
    ? {
        onMouseEnter: openTooltip,
        onMouseLeave: closeTooltip,
        onFocus: openTooltip,
        onBlur: closeTooltip,
      }
    : {}

  return (
    <>
      <a
        ref={linkRef}
        href={href}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        {...reveal}
        className={cn(
          "flex items-center rounded-lg transition-all duration-150 text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03]",
          collapsed ? "justify-center p-2" : "gap-3 px-2.5 py-2"
        )}
      >
        <div className={cn(
          "flex items-center justify-center rounded-lg shrink-0",
          collapsed ? "w-8 h-8" : "w-7 h-7",
          iconClass
        )}>
          <Icon className={cn(collapsed ? "w-4 h-4" : "w-3.5 h-3.5")} />
        </div>
        {!collapsed && <span className="text-xs font-medium">{label}</span>}
      </a>

      {tooltipOpen && collapsed && (
        <SidebarTooltip anchorRef={linkRef}>
          <span className="text-sm font-semibold text-ink whitespace-nowrap">{label}</span>
        </SidebarTooltip>
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Main SidebarNav
// ─────────────────────────────────────────────────────────────────────
export function SidebarNav() {
  const navigate = useNavigate()
  // Active section is derived from the URL — the single source of truth — so the
  // highlight can never desync from the route. Selector subscriptions below keep
  // this always-mounted shell from re-rendering on unrelated preference writes.
  const { pathname } = useLocation()
  const activeTab = tabForPath(pathname)
  const sidebarCollapsed = usePreferencesStore((s) => s.sidebarCollapsed)
  const toggleSidebar = usePreferencesStore((s) => s.toggleSidebar)

  const { viewCount } = useWorkspaceContext()

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


  const handleNavClick = (tabId: NavigationTab) => {
    switch (tabId) {
      case 'dashboard': navigate('/dashboard'); break
      case 'explore': navigate('/explorer'); break
      case 'workspaces': navigate('/workspaces'); break
      case 'ingestion': navigate('/ingestion'); break
      case 'schema': navigate('/schema'); break
      // Navigate to /admin (no sub-route). AdminPage's ``isRoot``
      // branch redirects to the first sub-page the current user can
      // see — so a delegated groups-admin lands on /admin/groups,
      // not on /admin/overview's access-denied panel.
      case 'admin': navigate('/admin'); break
    }
  }

  // Permission gate per nav item, driven by the centralised nav
  // catalogue served from the backend (seeded by bundled defaults).
  // Hooks are called in static order matching ``NAV_ITEMS_CONFIG``
  // (module-scope constant), so hook-rules stay satisfied across
  // renders. ``useSidebarSpec`` resolves the live spec from the store.
  const dashboardVisible  = useNavPermission(useSidebarSpec('dashboard'))
  const exploreVisible    = useNavPermission(useSidebarSpec('explore'))
  const workspacesVisible = useNavPermission(useSidebarSpec('workspaces'))
  const ingestionVisible  = useNavPermission(useSidebarSpec('ingestion'))
  const schemaVisible     = useNavPermission(useSidebarSpec('schema'))
  const adminVisible      = useNavPermission(useSidebarSpec('admin'))

  const visibility: Record<NavigationTab, boolean> = {
    dashboard:  dashboardVisible,
    explore:    exploreVisible,
    workspaces: workspacesVisible,
    ingestion:  ingestionVisible,
    schema:     schemaVisible,
    admin:      adminVisible,
  }

  // Populate nav item badges and filter to permission-allowed items.
  const mainNavItems: NavItemConfig[] = NAV_ITEMS_CONFIG
    .filter((item) => visibility[item.id])
    .map((item) => ({
      ...item,
      badge: item.id === 'explore' ? viewCount : undefined,
    }))

  return (
    <aside
      data-tour="nav"
      className="relative shrink-0 h-full z-40 bg-canvas-elevated border-r border-glass-border flex flex-col"
      style={{ width: sidebarCollapsed ? COLLAPSED_WIDTH : width, transition: resizing.current ? 'none' : 'width 200ms ease' }}
    >
      {/* Main Navigation */}
      <nav className="flex-1 flex flex-col overflow-y-auto custom-scrollbar pb-3">
        {/* Primary nav items */}
        <div className={cn("space-y-0.5 pt-2", sidebarCollapsed ? "px-1.5" : "px-2.5")}>
          {/* Sidebar toggle — integrated into nav flow */}
          <div className={cn(
            "flex mb-1",
            sidebarCollapsed ? "justify-center" : "justify-end"
          )}>
            <button
              onClick={toggleSidebar}
              className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {sidebarCollapsed
                ? <PanelLeftOpen className="w-4.5 h-4.5" />
                : <PanelLeftClose className="w-4.5 h-4.5" />
              }
            </button>
          </div>
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
      </nav>

      {/* User Guide link */}
      <div className={cn("border-t border-glass-border", sidebarCollapsed ? "px-1.5 pt-2" : "px-2.5 pt-2")}>
        <SidebarFooterLink
          href="/guide"
          label="User Guide"
          icon={Sparkles}
          iconClass="bg-gradient-to-br from-indigo-500 to-violet-600 text-white"
          collapsed={sidebarCollapsed}
        />
      </div>

      {/* Documentation link */}
      <div className={cn(sidebarCollapsed ? "px-1.5 pb-2" : "px-2.5 pb-2")}>
        <SidebarFooterLink
          href="/docs"
          label="Documentation"
          icon={BookOpen}
          iconClass="bg-black/[0.04] dark:bg-white/[0.06]"
          collapsed={sidebarCollapsed}
          external
        />
      </div>

      {/* Resize handle (right edge) — only when expanded */}
      {!sidebarCollapsed && (
        <div
          onMouseDown={onResizeMouseDown}
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-indigo-500/30 active:bg-indigo-500/50 transition-colors z-10"
        />
      )}
    </aside>
  )
}
