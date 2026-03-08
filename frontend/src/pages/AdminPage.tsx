/**
 * AdminPage — dedicated full-page administration console at /admin.
 * Provides a tabbed left sidebar navigating between:
 *   • Providers — CRUD + health checks
 *   • Workspaces — CRUD + data source management
 *   • Insights — cross-workspace analytics
 */
import { NavLink, Outlet, useLocation, Navigate } from 'react-router-dom'
import {
    Server, Database, BarChart3, ChevronRight, Shield,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const adminSections = [
    { path: 'providers', label: 'Providers', icon: Server, description: 'Database connections & health' },
    { path: 'workspaces', label: 'Workspaces', icon: Database, description: 'Environments & data sources' },
    { path: 'insights', label: 'Insights', icon: BarChart3, description: 'Graph statistics & analytics' },
]

export function AdminPage() {
    const location = useLocation()
    const isRoot = location.pathname === '/admin' || location.pathname === '/admin/'

    if (isRoot) {
        return <Navigate to="/admin/workspaces" replace />
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
                <nav className="flex-1 px-3 space-y-1">
                    {adminSections.map((section) => {
                        const Icon = section.icon
                        return (
                            <NavLink
                                key={section.path}
                                to={`/admin/${section.path}`}
                                className={({ isActive }) => cn(
                                    "w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left group transition-all duration-200",
                                    isActive
                                        ? "bg-gradient-to-r from-indigo-500/10 to-violet-500/10 text-indigo-600 dark:text-indigo-400 shadow-sm border border-indigo-500/20"
                                        : "text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink border border-transparent"
                                )}
                            >
                                <div className={cn(
                                    "w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors",
                                    "group-[.active]:bg-indigo-500/20 bg-black/5 dark:bg-white/5"
                                )}>
                                    <Icon className="w-4 h-4" />
                                </div>
                                <div className="flex flex-col min-w-0 flex-1">
                                    <span className="text-sm font-semibold truncate">{section.label}</span>
                                    <span className="text-[10px] text-ink-muted truncate">{section.description}</span>
                                </div>
                                <ChevronRight className="w-4 h-4 text-ink-muted opacity-0 group-hover:opacity-100 transition-opacity" />
                            </NavLink>
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
