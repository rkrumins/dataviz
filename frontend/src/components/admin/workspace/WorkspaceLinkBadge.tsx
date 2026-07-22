import { Link } from 'react-router-dom'
import { FolderOpen, ArrowUpRight } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
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
 * (/workspaces/:id). A styled tooltip previews the workspace name and its full
 * id (selectable) with an "open" hint, so workspace ownership reads and links
 * the same, premium way across Job History and the Data Sources list.
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
    <TooltipPrimitive.Provider delayDuration={250}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          <Link
            to={`/workspaces/${workspaceId}`}
            onClick={e => e.stopPropagation()}
            aria-label={`Open workspace ${workspaceName}`}
            className={cn(
              'group/ws inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 max-w-full align-middle',
              'bg-black/[0.03] dark:bg-white/[0.04] text-ink-muted',
              'transition-colors duration-150',
              'hover:bg-indigo-500/10 hover:text-indigo-500',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500/40 focus-visible:text-indigo-500',
              className,
            )}
          >
            <Icon className="h-2.5 w-2.5 shrink-0 opacity-70 transition-opacity group-hover/ws:opacity-100" />
            <span className="truncate max-w-[150px]">{workspaceName}</span>
          </Link>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side="top"
            align="start"
            sideOffset={6}
            className="z-50 max-w-[260px] rounded-lg bg-ink px-3 py-2 text-canvas shadow-lg animate-in fade-in zoom-in-95 duration-150"
          >
            <div className="flex flex-col gap-1">
              <span className="text-[9px] font-bold uppercase tracking-wider opacity-50">Workspace</span>
              <span className="text-[12px] font-semibold leading-tight">{workspaceName}</span>
              <span className="font-mono text-[10px] break-all opacity-60 select-all">{workspaceId}</span>
              <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] font-medium opacity-80">
                <ArrowUpRight className="h-2.5 w-2.5" /> Open workspace
              </span>
            </div>
            <TooltipPrimitive.Arrow className="fill-ink" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  )
}
