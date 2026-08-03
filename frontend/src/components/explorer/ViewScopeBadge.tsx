/**
 * ViewScopeBadge — Reusable workspace + data source pill pair.
 *
 * Renders a coloured workspace pill and, when a data source is present,
 * an emerald-tinted data source pill beside it.  When provider details are
 * supplied, a third pill shows the provider the source is built from.  Used
 * across Explorer cards, list rows, hero, recent strip, and preview drawer.
 */
import { Database, Server } from 'lucide-react'
import { cn } from '@/lib/utils'
import { workspaceColor } from '@/lib/workspaceColor'

interface ViewScopeBadgeProps {
  workspaceId: string
  workspaceName?: string | null
  dataSourceId?: string | null
  dataSourceName?: string | null
  /** Provider the data source is built from (resolved via catalog → provider). */
  providerName?: string | null
  providerType?: string | null
  /** 'sm' for cards/rows, 'md' for hero/drawer */
  size?: 'sm' | 'md'
  /** Hide the workspace pill — for contexts already scoped to one workspace
   *  (e.g. the workspace-detail Views tab) where it's redundant on every row. */
  hideWorkspace?: boolean
}

export function ViewScopeBadge({
  workspaceId,
  workspaceName,
  dataSourceId,
  dataSourceName,
  providerName,
  providerType,
  size = 'sm',
  hideWorkspace,
}: ViewScopeBadgeProps) {
  const wsColor = workspaceColor(workspaceId)
  const textSize = size === 'sm' ? 'text-[10px]' : 'text-xs'
  // Cap each pill so a long name truncates on ONE line (…) with a title
  // tooltip, instead of wrapping to multiple lines or overflowing a narrow
  // table column. min-w-0 lets the pill shrink further inside a constrained
  // flex track (e.g. the list-row scope cell).
  const pillMax = size === 'sm' ? 'max-w-[130px]' : 'max-w-[200px]'

  return (
    <>
      {/* Workspace pill */}
      {!hideWorkspace && (
        <span
          className={cn(
            'inline-flex items-center rounded-full border px-2 py-0.5 font-semibold leading-none min-w-0',
            pillMax,
            textSize,
            wsColor.bg,
            wsColor.text,
            wsColor.border,
          )}
          title={workspaceName ?? 'Workspace'}
        >
          {/* Non-members have no name for this workspace — a neutral label
              beats leaking a raw UUID into the UI. */}
          <span className="truncate">{workspaceName ?? 'Workspace'}</span>
        </span>
      )}

      {/* Data source pill */}
      {dataSourceId && (
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/8 px-2 py-0.5 font-medium leading-none text-emerald-600 dark:text-emerald-400 min-w-0',
            pillMax,
            textSize,
          )}
          title={dataSourceName ?? 'Data source'}
        >
          <Database className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate">{dataSourceName ?? 'Data source'}</span>
        </span>
      )}

      {/* Provider pill */}
      {providerName && (
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full border border-sky-500/20 bg-sky-500/8 px-2 py-0.5 font-medium leading-none text-sky-600 dark:text-sky-400 min-w-0',
            pillMax,
            textSize,
          )}
          title={providerType ? `Provider: ${providerName} · ${providerType}` : `Provider: ${providerName}`}
        >
          <Server className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate">{providerName}</span>
        </span>
      )}
    </>
  )
}
