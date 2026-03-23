/**
 * ViewScopeBadge — Reusable workspace + data source pill pair.
 *
 * Renders a coloured workspace pill and, when a data source is present,
 * an emerald-tinted data source pill beside it.  Used across Explorer
 * cards, list rows, hero, recent strip, and preview drawer.
 */
import { Database } from 'lucide-react'
import { cn } from '@/lib/utils'
import { workspaceColor } from '@/lib/workspaceColor'

interface ViewScopeBadgeProps {
  workspaceId: string
  workspaceName?: string | null
  dataSourceId?: string | null
  dataSourceName?: string | null
  /** 'sm' for cards/rows, 'md' for hero/drawer */
  size?: 'sm' | 'md'
}

export function ViewScopeBadge({
  workspaceId,
  workspaceName,
  dataSourceId,
  dataSourceName,
  size = 'sm',
}: ViewScopeBadgeProps) {
  const wsColor = workspaceColor(workspaceId)
  const textSize = size === 'sm' ? 'text-[10px]' : 'text-xs'

  return (
    <>
      {/* Workspace pill */}
      <span
        className={cn(
          'inline-flex items-center rounded-full border px-2 py-0.5 font-semibold leading-none',
          textSize,
          wsColor.bg,
          wsColor.text,
          wsColor.border,
        )}
      >
        {workspaceName ?? workspaceId}
      </span>

      {/* Data source pill */}
      {dataSourceId && (
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/8 px-2 py-0.5 font-medium leading-none text-emerald-600 dark:text-emerald-400',
            textSize,
          )}
        >
          <Database className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate max-w-[120px]">
            {dataSourceName ?? dataSourceId}
          </span>
        </span>
      )}
    </>
  )
}
