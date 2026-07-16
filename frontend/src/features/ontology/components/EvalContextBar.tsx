/**
 * EvalContextBar — makes the page's evaluation target explicit.
 *
 * Coverage/Overview/Schema evaluate the selected ontology against ONE data
 * source, resolved by the page (explicit pick → first assigned source →
 * globally-active source). That chain used to be silent; this bar states it
 * permanently: which data source, in which workspace, found on which graph
 * data provider (and where), and whether that source actually uses this
 * layer ("assigned") or is just being previewed against it.
 *
 * Provider identity comes from useDataSourceProviderMap (catalog+providers
 * caches). Non-admins can't read those lists, so entries resolve degraded
 * (providerType 'unknown', no host) or not at all — in that case the
 * provider segment is simply omitted, never shown as "unknown".
 */
import { Database, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceResponse, DataSourceResponse } from '@/services/workspaceService'
import type { DataSourceProviderInfo } from '@/components/admin/workspace/useWorkspaceDetailData'
import { getProviderLogo } from '@/components/admin/ProviderLogos'
import { useDataSourceProviderMap } from '@/hooks/useDataSourceProviderMap'

interface EvalContextBarProps {
  ontologyId: string
  workspace: WorkspaceResponse | null
  dataSource: DataSourceResponse | null
  onChangeTarget: () => void
}

export function EvalContextBar({ ontologyId, workspace, dataSource, onChangeTarget }: EvalContextBarProps) {
  const { resolve } = useDataSourceProviderMap()
  return (
    <EvalContextBarView
      ontologyId={ontologyId}
      workspace={workspace}
      dataSource={dataSource}
      providerInfo={resolve(dataSource?.id)}
      onChangeTarget={onChangeTarget}
    />
  )
}

/** Presentational half — exported for tests (no store/query dependencies). */
export function EvalContextBarView({ ontologyId, workspace, dataSource, providerInfo, onChangeTarget }: EvalContextBarProps & {
  providerInfo?: DataSourceProviderInfo
}) {
  // Degraded resolution (non-admin, or provider list not loaded) shows up as
  // providerType 'unknown' — treat it the same as no resolution at all.
  const provider = providerInfo && providerInfo.providerType !== 'unknown' ? providerInfo : undefined
  const graphName = provider?.sourceIdentifier ?? dataSource?.graphName
  const isAssigned = !!dataSource && dataSource.ontologyId === ontologyId
  const ProviderLogo = provider ? getProviderLogo(provider.providerType) : null

  return (
    <div className="flex items-center gap-2.5 px-4 py-2 rounded-xl border border-glass-border bg-canvas-elevated/60 text-xs text-ink-muted min-w-0">
      <div className="w-6 h-6 rounded-lg bg-indigo-500/10 border border-indigo-500/15 flex items-center justify-center flex-shrink-0">
        {ProviderLogo ? <ProviderLogo className="w-3.5 h-3.5" /> : <Database className="w-3.5 h-3.5 text-indigo-500" />}
      </div>

      {dataSource ? (
        <>
          <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
            <span>Evaluating</span>
            <span className="font-semibold text-ink truncate max-w-[180px]">{dataSource.label || dataSource.id}</span>
            {graphName && (
              <>
                <span className="text-ink-muted/40">·</span>
                <span className="whitespace-nowrap">graph <span className="font-mono text-ink-secondary">{graphName}</span></span>
              </>
            )}
            {workspace && (
              <>
                <span className="text-ink-muted/40">·</span>
                <span className="whitespace-nowrap">in <span className="font-semibold text-ink">{workspace.name}</span></span>
              </>
            )}
            {provider && (
              <>
                <span className="text-ink-muted/40">·</span>
                <span className="truncate">
                  on <span className="font-semibold text-ink">{provider.providerName}</span>
                  {' '}({provider.providerType}{provider.host ? `, ${provider.host}${provider.port != null ? `:${provider.port}` : ''}` : ''})
                </span>
              </>
            )}
          </div>

          <span
            className={cn(
              'inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-bold border flex-shrink-0 uppercase tracking-wide',
              isAssigned
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
                : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
            )}
            title={isAssigned
              ? 'This data source uses this semantic layer'
              : "Preview — this source doesn't use this layer yet"}
          >
            {isAssigned ? 'assigned' : 'preview'}
          </span>
        </>
      ) : (
        <span className="text-ink-muted">No evaluation target — pick a data source to analyze against</span>
      )}

      <button
        onClick={onChangeTarget}
        className="ml-auto flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold text-indigo-500 hover:text-indigo-600 hover:bg-indigo-500/[0.06] transition-colors flex-shrink-0"
      >
        <Pencil className="w-3 h-3" /> Change
      </button>
    </div>
  )
}
