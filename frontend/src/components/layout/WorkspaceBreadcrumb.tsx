/**
 * WorkspaceBreadcrumb — shows Workspace > DataSource > View in the TopBar
 * for persistent orientation. Each segment is interactive.
 */
import { ChevronRight, Database } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { motion, AnimatePresence } from 'framer-motion'
import { useWorkspaceContext } from '@/hooks/useWorkspaceContext'
import { wsGradient } from '@/lib/viewUtils'
import { cn } from '@/lib/utils'

export function WorkspaceBreadcrumb() {
  const {
    workspace,
    workspaceIndex,
    dataSource,
    activeView,
    switchDataSource,
  } = useWorkspaceContext()

  const location = useLocation()
  const isViewPage = location.pathname.startsWith('/views/')

  if (!workspace) return null

  return (
    <nav className="flex items-center gap-1 text-sm min-w-0" aria-label="Workspace context">
      <AnimatePresence mode="popLayout">
        {/* Workspace segment */}
        <motion.div
          key={`ws-${workspace.id}`}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -8 }}
          transition={{ duration: 0.15 }}
          className="flex items-center gap-1.5 min-w-0"
        >
          <div
            className={cn(
              'w-5 h-5 rounded flex items-center justify-center text-[9px] font-bold text-white shrink-0',
              `bg-gradient-to-br ${wsGradient(workspaceIndex)}`
            )}
          >
            {workspace.name.charAt(0).toUpperCase()}
          </div>
          <span className="font-medium text-ink truncate max-w-[140px]">
            {workspace.name}
          </span>
        </motion.div>

        {/* DataSource segment */}
        {dataSource && (
          <motion.div
            key={`ds-${dataSource.id}`}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.15, delay: 0.05 }}
            className="flex items-center gap-1 min-w-0"
          >
            <ChevronRight className="w-3 h-3 text-ink-muted shrink-0" />
            <DataSourceDropdown
              workspace={workspace}
              activeDataSourceId={dataSource.id}
              onSelect={switchDataSource}
            >
              <button className="text-ink-secondary hover:text-ink truncate max-w-[140px] transition-colors">
                {dataSource.label || dataSource.catalogItemId || 'Data Source'}
              </button>
            </DataSourceDropdown>
          </motion.div>
        )}

        {/* View segment — only on /views/:id */}
        {isViewPage && activeView && (
          <motion.div
            key={`view-${activeView.id}`}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.15, delay: 0.1 }}
            className="flex items-center gap-1 min-w-0"
          >
            <ChevronRight className="w-3 h-3 text-ink-muted shrink-0" />
            <span className="text-ink-secondary truncate max-w-[140px]">
              {activeView.name}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  )
}

// ── DataSource Dropdown ───────────────────────────────────────────────

function DataSourceDropdown({
  workspace,
  activeDataSourceId,
  onSelect,
  children,
}: {
  workspace: { dataSources: Array<{ id: string; label?: string; catalogItemId: string; isPrimary: boolean }> }
  activeDataSourceId: string
  onSelect: (dsId: string) => void
  children: React.ReactNode
}) {
  const dataSources = workspace.dataSources ?? []

  // If only 1 data source, just render the label (non-interactive)
  if (dataSources.length <= 1) {
    return <>{children}</>
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="min-w-[180px] bg-canvas-elevated border border-glass-border rounded-xl shadow-xl p-1.5 z-50 animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
          sideOffset={8}
          align="start"
        >
          {dataSources.map((ds) => (
            <DropdownMenu.Item
              key={ds.id}
              className={cn(
                'flex items-center gap-2 px-3 py-2 text-sm rounded-lg cursor-pointer outline-none transition-colors',
                ds.id === activeDataSourceId
                  ? 'bg-accent-lineage/10 text-accent-lineage'
                  : 'text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink'
              )}
              onSelect={() => onSelect(ds.id)}
            >
              <Database className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{ds.label || ds.catalogItemId}</span>
              {ds.isPrimary && (
                <span className="ml-auto text-2xs text-ink-muted">primary</span>
              )}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
