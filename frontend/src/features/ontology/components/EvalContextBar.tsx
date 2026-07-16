/**
 * EvalContextBar — the schema's applications, and the one being analyzed.
 *
 * The schema (ontology) is the first-class citizen here: the bar leads with
 * "This schema powers" — a chip per data source that USES this layer — and
 * only then states which of them the single-target tabs (overview/schema/
 * coverage) are currently analyzing, with full identity (graph · workspace ·
 * provider · host) and the PROVENANCE of that choice: picked by the user,
 * auto-selected as the first application, or a preview of the
 * workspace-active source that doesn't use this schema at all.
 *
 * Clicking any application chip switches the analysis to it; "Change" opens
 * the full cross-workspace picker (for evaluating against unassigned
 * sources); "Assign" opens the assignment manager.
 *
 * Provider identity comes from useDataSourceProviderMap (catalog+providers
 * caches). Non-admins can't read those lists, so entries resolve degraded
 * (providerType 'unknown', no host) or not at all — the provider segment is
 * simply omitted, never shown as "unknown".
 */
import { Check, Database, Link2, Pencil, Plus, Settings2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceResponse, DataSourceResponse } from '@/services/workspaceService'
import type { DataSourceProviderInfo } from '@/components/admin/workspace/useWorkspaceDetailData'
import { getProviderLogo } from '@/components/admin/ProviderLogos'
import { useDataSourceProviderMap } from '@/hooks/useDataSourceProviderMap'

/** How the current evaluation target was arrived at. */
export type EvalSelectionSource = 'user' | 'auto-assigned' | 'workspace-active'

/** One data source this schema is applied to. */
export interface SchemaApplication {
  workspace: WorkspaceResponse
  dataSource: DataSourceResponse
}

interface EvalContextBarProps {
  ontologyId: string
  /** All workspaces — the bar derives the schema's applications from them. */
  workspaces: WorkspaceResponse[]
  workspace: WorkspaceResponse | null
  dataSource: DataSourceResponse | null
  selectionSource: EvalSelectionSource
  /** Analyze a specific application (chip click). */
  onSelectTarget: (workspaceId: string, dataSourceId: string) => void
  /** Open the full cross-workspace picker (incl. unassigned sources). */
  onChangeTarget: () => void
  /** Open the assignment manager (the single assignment write surface). */
  onManageAssignments?: () => void
}

const MAX_CHIPS = 4

export function EvalContextBar(props: EvalContextBarProps) {
  const { resolve } = useDataSourceProviderMap()
  return <EvalContextBarView {...props} resolveProvider={resolve} />
}

/** Presentational half — exported for tests (no store/query dependencies). */
export function EvalContextBarView({
  ontologyId, workspaces, workspace, dataSource, selectionSource,
  onSelectTarget, onChangeTarget, onManageAssignments,
  resolveProvider,
}: EvalContextBarProps & {
  resolveProvider: (dsId?: string | null) => DataSourceProviderInfo | undefined
}) {
  // The schema's applications — every source that uses this layer.
  const applications: SchemaApplication[] = []
  for (const ws of workspaces) {
    for (const ds of ws.dataSources ?? []) {
      if (ds.ontologyId === ontologyId) applications.push({ workspace: ws, dataSource: ds })
    }
  }

  const isAssigned = !!dataSource && dataSource.ontologyId === ontologyId

  // Keep the analyzed application visible even when it pages past MAX_CHIPS.
  let visible = applications.slice(0, MAX_CHIPS)
  if (dataSource && isAssigned && !visible.some(a => a.dataSource.id === dataSource.id)) {
    const selected = applications.find(a => a.dataSource.id === dataSource.id)
    if (selected) visible = [...applications.slice(0, MAX_CHIPS - 1), selected]
  }
  const hiddenCount = applications.length - visible.length

  const providerRaw = resolveProvider(dataSource?.id)
  const provider = providerRaw && providerRaw.providerType !== 'unknown' ? providerRaw : undefined
  const graphName = provider?.sourceIdentifier ?? dataSource?.graphName

  return (
    <div className="rounded-xl border border-glass-border bg-canvas-elevated/60 px-4 py-2.5 space-y-2 min-w-0">
      {/* ── Row 1: the schema's applications ─────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap min-w-0">
        <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted flex items-center gap-1.5 flex-shrink-0">
          <Link2 className="w-3 h-3" /> This schema powers
        </span>

        {applications.length === 0 ? (
          <span className="text-xs text-ink-muted italic">no data sources yet</span>
        ) : (
          visible.map(({ workspace: ws, dataSource: ds }) => {
            const chipProviderRaw = resolveProvider(ds.id)
            const chipProvider = chipProviderRaw && chipProviderRaw.providerType !== 'unknown' ? chipProviderRaw : undefined
            const ChipLogo = chipProvider ? getProviderLogo(chipProvider.providerType) : null
            const isCurrent = dataSource?.id === ds.id
            return (
              <button
                key={ds.id}
                onClick={() => onSelectTarget(ws.id, ds.id)}
                title={isCurrent
                  ? `Currently analyzing ${ds.label || ds.id}`
                  : `Analyze ${ds.label || ds.id} (${ws.name})`}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold transition-all',
                  isCurrent
                    ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/30 ring-1 ring-indigo-500/20'
                    : 'border-glass-border text-ink-secondary hover:text-ink hover:border-indigo-500/30 hover:bg-indigo-500/[0.04]',
                )}
              >
                {isCurrent && <Check className="w-3 h-3 flex-shrink-0" />}
                {ChipLogo ? <ChipLogo className="w-3 h-3 flex-shrink-0" /> : <Database className="w-3 h-3 flex-shrink-0 text-ink-muted" />}
                <span className="truncate max-w-[140px]">{ds.label || ds.id}</span>
                <span className="text-ink-muted/70 font-normal truncate max-w-[100px]">· {ws.name}</span>
              </button>
            )
          })
        )}

        {hiddenCount > 0 && (
          <button
            onClick={onChangeTarget}
            className="inline-flex items-center px-2 py-1 rounded-full border border-glass-border text-[11px] font-semibold text-ink-muted hover:text-ink hover:border-indigo-500/30 transition-colors"
          >
            +{hiddenCount} more
          </button>
        )}

        {onManageAssignments && (
          <button
            onClick={onManageAssignments}
            className="ml-auto flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold text-ink-muted hover:text-indigo-500 hover:bg-indigo-500/[0.06] transition-colors flex-shrink-0"
            title={applications.length === 0
              ? 'Apply this schema to a data source'
              : 'Manage which data sources use this schema'}
          >
            {applications.length === 0 ? <Plus className="w-3 h-3" /> : <Settings2 className="w-3 h-3" />}
            {applications.length === 0 ? 'Assign' : 'Manage'}
          </button>
        )}
      </div>

      {/* ── Row 2: the analyzed target — full identity + provenance ──── */}
      <div className={cn(
        'flex items-center gap-2 flex-wrap text-xs min-w-0 pt-2 border-t border-glass-border/40',
        isAssigned ? 'text-ink-muted' : 'text-amber-700 dark:text-amber-400',
      )}>
        {dataSource ? (
          <>
            <span className="flex-shrink-0">{isAssigned ? 'Analyzing' : 'Previewing against'}</span>
            <span className={cn('font-semibold truncate max-w-[180px]', isAssigned ? 'text-ink' : '')}>
              {dataSource.label || dataSource.id}
            </span>
            {graphName && (
              <>
                <span className="opacity-40">·</span>
                <span className="whitespace-nowrap">graph <span className={cn('font-mono', isAssigned && 'text-ink-secondary')}>{graphName}</span></span>
              </>
            )}
            {workspace && (
              <>
                <span className="opacity-40">·</span>
                <span className="whitespace-nowrap">in <span className={cn('font-semibold', isAssigned && 'text-ink')}>{workspace.name}</span></span>
              </>
            )}
            {provider && (
              <>
                <span className="opacity-40">·</span>
                <span className="truncate">
                  on <span className={cn('font-semibold', isAssigned && 'text-ink')}>{provider.providerName}</span>
                  {' '}({provider.providerType}{provider.host ? `, ${provider.host}${provider.port != null ? `:${provider.port}` : ''}` : ''})
                </span>
              </>
            )}

            {/* Provenance — how this target was arrived at */}
            <span
              className={cn(
                'inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-bold border flex-shrink-0 uppercase tracking-wide',
                !isAssigned
                  ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'
                  : selectionSource === 'user'
                    ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20'
                    : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
              )}
              title={!isAssigned
                ? "This is the workspace-active source from the environment switcher. It doesn't use this schema — results are a preview of the fit. Assign it to make this schema its lens."
                : selectionSource === 'user'
                  ? 'You picked this source for analysis.'
                  : 'Auto-selected: the first data source using this schema. Click another chip above to switch.'}
            >
              {!isAssigned ? 'preview · not using this schema'
                : selectionSource === 'user' ? 'your selection'
                : 'auto-selected'}
            </span>
          </>
        ) : (
          <span className="italic">
            {applications.length === 0
              ? 'Nothing to analyze yet — assign this schema to a data source, or pick one to preview the fit.'
              : 'No analysis target — pick one of the sources above.'}
          </span>
        )}

        <button
          onClick={onChangeTarget}
          className="ml-auto flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold text-indigo-500 hover:text-indigo-600 hover:bg-indigo-500/[0.06] transition-colors flex-shrink-0"
        >
          <Pencil className="w-3 h-3" /> Change
        </button>
      </div>
    </div>
  )
}
