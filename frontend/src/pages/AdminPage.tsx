/**
 * AdminPage — dedicated full-page administration console at /admin.
 * Provides a tabbed left sidebar navigating between:
 *   • Providers — CRUD + health checks
 *   • Workspaces — CRUD + data source management
 *   • Insights — cross-workspace analytics
 */
import { useState } from 'react'
import { NavLink, Outlet, useLocation, Navigate } from 'react-router-dom'
import {
    BarChart3, Shield, ChevronDown, ToggleLeft, Users, Megaphone
} from 'lucide-react'
import { cn } from '@/lib/utils'

// Administration is scoped to system-level concerns. Workspaces and data ingestion
// live as their own top-level sidebar destinations (/workspaces, /ingestion).
const adminGroups = [
    {
        id: 'system',
        label: 'System',
        icon: Shield,
        path: '',
        items: [
            { path: 'overview', label: 'Global Overview', icon: BarChart3, description: 'System health & scale' },
            { path: 'features', label: 'Features', icon: ToggleLeft, description: 'Feature flags & behaviour' },
            { path: 'users', label: 'User Management', icon: Users, description: 'Accounts & approvals' },
            { path: 'announcements', label: 'Announcements', icon: Megaphone, description: 'Global banner messages' },
        ]
    }
]

export function AdminPage() {
    const location = useLocation()
    const isRoot = location.pathname === '/admin' || location.pathname === '/admin/'

    if (isRoot) {
        return <Navigate to="/admin/overview" replace />
    }

    return (
        <div className="absolute inset-0 flex bg-canvas">
            {/* Admin Sidebar */}
            <aside className="w-72 shrink-0 border-r border-glass-border bg-canvas-elevated flex flex-col">
                {/* Header */}
                <div className="px-6 pt-6 pb-4">
                    <div className="flex items-center gap-3 mb-1">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
                            <Shield className="w-5 h-5 text-white" />
                        </div>
                        <div>
                            <h1 className="text-lg font-bold text-ink leading-tight">Administration</h1>
                            <p className="text-[11px] text-ink-muted">System configuration</p>
                        </div>
                    </div>
                </div>

                {/* Navigation */}
                <nav className="flex-1 px-3 space-y-4 pt-2">
                    {adminGroups.map((group) => {
                        const GroupIcon = group.icon
                        // Check if any child is active to keep the group open and highlighted
                        const isGroupActive = group.items.some(item => location.pathname.includes(`/admin/${item.path}`))

                        // Default to open if active, otherwise open
                        const [isOpen, setIsOpen] = useState(true)

                        return (
                            <div key={group.id} className="space-y-1">
                                {/* Group Header Wrapper */}
                                <div className="flex items-center w-full px-2 py-1.5 rounded-lg group/header hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                                    <NavLink
                                        to={`/admin/${group.path}`}
                                        className={({ isActive }) => cn(
                                            "flex-1 flex items-center gap-2 outline-none rounded-md focus-visible:ring-2 focus-visible:ring-indigo-500/50 p-1",
                                            isActive || isGroupActive ? "text-indigo-500" : "text-ink-muted hover:text-ink-secondary"
                                        )}
                                    >
                                        <GroupIcon className="w-4 h-4 transition-colors" />
                                        <span className="text-xs font-bold uppercase tracking-wider">
                                            {group.label}
                                        </span>
                                    </NavLink>
                                    <button
                                        onClick={(e) => {
                                            e.preventDefault()
                                            setIsOpen(!isOpen)
                                        }}
                                        className="p-1.5 rounded-md text-ink-muted hover:text-ink-secondary hover:bg-black/10 dark:hover:bg-white/10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                                        aria-label="Toggle section"
                                    >
                                        <ChevronDown className={cn(
                                            "w-3.5 h-3.5 transition-transform duration-200",
                                            isOpen ? "" : "-rotate-90"
                                        )} />
                                    </button>
                                </div>

                                {/* Group Items */}
                                <div className={cn(
                                    "grid transition-all duration-200 ease-in-out",
                                    isOpen ? "grid-rows-[1fr] opacity-100 mt-1" : "grid-rows-[0fr] opacity-0 mt-0"
                                )}>
                                    <div className="overflow-hidden space-y-1">
                                        {group.items.map((item) => {
                                            const ItemIcon = item.icon
                                            return (
                                                <NavLink
                                                    key={item.path}
                                                    to={`/admin/${item.path}`}
                                                    className={({ isActive }) => cn(
                                                        "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left group transition-all duration-200 relative",
                                                        isActive
                                                            ? "bg-gradient-to-r from-indigo-500/10 to-violet-500/10 text-indigo-600 dark:text-indigo-400 shadow-sm border border-indigo-500/20"
                                                            : "text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink border border-transparent"
                                                    )}
                                                >
                                                    <div className={cn(
                                                        "w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-colors",
                                                        "group-[.active]:bg-indigo-500/20 bg-black/5 dark:bg-white/5"
                                                    )}>
                                                        <ItemIcon className="w-3.5 h-3.5" />
                                                    </div>
                                                    <div className="flex flex-col min-w-0 flex-1">
                                                        <span className="text-sm font-semibold truncate leading-tight">{item.label}</span>
                                                        <span className="text-[10px] text-ink-muted truncate mt-0.5">{item.description}</span>
                                                    </div>
                                                </NavLink>
                                            )
                                        })}
                                    </div>
                                </div>
                            </div>
                        )
                    })}
                </nav>

                {/* Version tag */}
                <div className="px-6 py-4 border-t border-glass-border">
                    <p className="text-[10px] text-ink-muted text-center">Synodic Admin v1.0</p>
                </div>
            </aside>

            {/* Content Area */}
            <main className="flex-1 overflow-y-auto">
                <Outlet />
            </main>
        </div>
    )
}
