import { Link } from 'react-router-dom'
import { FolderOpen } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

interface WorkspaceLinkBadgeProps {
  workspaceId: string
  workspaceName: string
  /** Icon shown before the name. Defaults to FolderOpen. */
  icon?: LucideIcon
  className?: string
}

/**
 * Small clickable workspace chip — the name links to the Workspaces page
 * (/workspaces/:id) and the full workspace id shows on hover. Reused across
 * Job History rows and the Data Sources list so workspace ownership reads and
 * links the same way everywhere.
 *
 * stopPropagation: the rows/cards that host this badge are themselves clickable
 * (expand/toggle), so the link must navigate without also firing the row's
 * onClick handler.
 */
export function WorkspaceLinkBadge({
  workspaceId,
  workspaceName,
  icon: Icon = FolderOpen,
  className,
}: WorkspaceLinkBadgeProps) {
  return (
    <Link
      to={`/workspaces/${workspaceId}`}
      onClick={e => e.stopPropagation()}
      title={`Workspace · ${workspaceName} · ID ${workspaceId}`}
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/[0.03] dark:bg-white/[0.04] text-ink-muted transition-colors hover:bg-indigo-500/10 hover:text-indigo-500',
        className,
      )}
    >
      <Icon className="w-2.5 h-2.5 text-ink-muted/50" />
      <span className="truncate max-w-[140px]">{workspaceName}</span>
    </Link>
  )
}
