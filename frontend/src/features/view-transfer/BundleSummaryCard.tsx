/**
 * What a view file holds, in one card: the view (name, kind, size, version, who exported it and
 * where from) and the source it was built on, so the person importing it can see at a glance
 * what they have and where it belongs.
 */
import { createElement } from 'react'
import { ArrowRight, Boxes, Database, Layers } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { DynamicIcon, resolveViewIcon, viewTypeLabel, viewTypeMeta } from '@/lib/viewUtils'
import { getProviderLogo } from '@/components/admin/ProviderLogos'
import type { BundleHeader, InspectedView } from '@/services/viewTransferApiService'
import { pluralize } from './format'

export function BundleSummaryCard({ view, bundle }: { view: InspectedView; bundle: BundleHeader }) {
  const meta = viewTypeMeta(view.metadata.viewType)
  const source = bundle.sources[view.source]
  const counts = view.manifest.counts ?? {}
  const environment = bundle.generator.environment
  const exportedBy = bundle.exportedBy.displayName
  const providerType = source?.dataSource.providerType

  return (
    <div className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
      <div className="flex items-start gap-3.5 p-4">
        <span className={cn('w-11 h-11 rounded-xl border flex items-center justify-center shrink-0', meta.iconBg)}>
          <DynamicIcon name={resolveViewIcon({ icon: view.metadata.icon, viewType: view.metadata.viewType })} className="w-5 h-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <p className="text-sm font-bold text-ink truncate" title={view.metadata.name}>{view.metadata.name}</p>
            <span className="shrink-0 rounded-full bg-black/[0.04] dark:bg-white/[0.06] px-2 py-0.5 text-[10px] font-semibold text-ink-secondary">
              {viewTypeLabel(view.metadata.viewType)}
            </span>
          </div>
          {view.metadata.description && (
            <p className="text-xs text-ink-muted mt-0.5 line-clamp-2">{view.metadata.description}</p>
          )}
          <p className="text-[11px] text-ink-muted mt-1.5">
            {view.version ? <span className="font-semibold text-ink-secondary">v{view.version}</span> : 'A view'}
            {environment ? <> from <span className="font-semibold text-ink-secondary">{environment}</span></> : null}
            {exportedBy ? <>, exported by {exportedBy}</> : null}
            {bundle.exportedAt ? <> {timeAgo(bundle.exportedAt)}</> : null}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-4 border-t border-glass-border divide-x divide-glass-border">
        {([
          ['layers', counts.layers], ['placements', counts.assignments], ['rules', counts.rules],
          ['display rules', counts.displayRules],
        ] as Array<[string, number | undefined]>).map(([label, value]) => (
          <div key={label} className="px-3 py-2 text-center">
            <p className="text-sm font-bold text-ink tabular-nums">{(value ?? 0).toLocaleString()}</p>
            <p className="text-[10px] text-ink-muted">{label}</p>
          </div>
        ))}
      </div>

      {source && (
        <div className="flex items-center gap-2 flex-wrap border-t border-glass-border bg-black/[0.015] dark:bg-white/[0.02] px-4 py-2.5 text-[11px] text-ink-secondary">
          <span className="text-ink-muted">Built on</span>
          {source.workspace.name && (
            <span className="inline-flex items-center gap-1 font-medium"><Boxes className="w-3 h-3 text-ink-muted" />{source.workspace.name}</span>
          )}
          {source.dataSource.label && (
            <>
              <ArrowRight className="w-3 h-3 text-ink-muted" />
              <span className="inline-flex items-center gap-1 font-medium">
                {providerType
                  ? createElement(getProviderLogo(providerType), { className: 'w-3 h-3' })
                  : <Database className="w-3 h-3 text-ink-muted" />}
                {source.dataSource.label}
                {source.dataSource.graphName && <span className="font-mono text-ink-muted">· {source.dataSource.graphName}</span>}
              </span>
            </>
          )}
          {source.ontology.name && (
            <>
              <ArrowRight className="w-3 h-3 text-ink-muted" />
              <span className="inline-flex items-center gap-1 font-medium"><Layers className="w-3 h-3 text-ink-muted" />{source.ontology.name}</span>
            </>
          )}
          {view.manifest.counts?.assignments ? (
            <span className="ml-auto text-ink-muted">{pluralize(Object.keys(view.manifest.entities ?? {}).length, 'entity', 'entities')} named</span>
          ) : null}
        </div>
      )}
    </div>
  )
}
