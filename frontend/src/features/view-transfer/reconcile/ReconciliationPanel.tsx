/**
 * The full account of how a view from a file fits a data source here.
 *
 *   ┌ score ring ┬ verdict, one sentence, source → target ┐
 *   ├ category cards: entities · anchors · entity types · relationship types · layers · display rules ┤
 *   ├ update panel (updating a view that's here) ┤
 *   ├ types that don't exist here, each mappable ┤
 *   ├ layer health ┤
 *   └ every entity not simply found, with keep / drop / remap ┘
 *
 * Presentation only: the reconcile itself, and when to re-run it, belong to the host (the
 * wizard's Match step, or one row of a multi-view import).
 */
import { AlertTriangle, ArrowRight, Anchor, Ban, CheckCircle2, GitFork, Info, Layers, Link2, Palette, Shapes } from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  BundleEntityInfo, ReconciledView, ReconcileNotice, Resolutions, UpdateStrategy,
} from '@/services/viewTransferApiService'
import { percent, pluralize } from '../format'
import { ExceptionsTable } from './ExceptionsTable'
import type { EntitySearchScope } from './EntitySearchPicker'
import { MatchScoreRing } from './MatchScoreRing'
import { projectedRate, sameResolutions } from './resolutions'
import { TypeMappingTable } from './TypeMappingTable'
import { UpdatePanel } from './UpdatePanel'

const VERDICT_META = {
  ready: { label: 'Ready to import', icon: CheckCircle2, cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  attention: { label: 'Worth a look', icon: AlertTriangle, cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  blocked: { label: "Can't import here", icon: Ban, cls: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300' },
} as const

export function ReconciliationPanel({
  reconciled, applied, draft, onDraft, onStrategy, sourceLabel, targetLabel, targetName,
  availableTypes, exportedNames, searchScope,
}: {
  reconciled: ReconciledView
  applied: Resolutions
  draft: Resolutions
  onDraft: (next: Resolutions) => void
  onStrategy?: (strategy: UpdateStrategy) => void
  sourceLabel: string
  targetLabel: string
  targetName?: string
  availableTypes: { entity: Array<{ id: string; name: string }>; relationship: Array<{ id: string; name: string }> }
  exportedNames: Record<string, BundleEntityInfo>
  /** The data source the view is going into, where a remap searches for an entity. */
  searchScope?: EntitySearchScope | null
}) {
  const { report, update } = reconciled
  const s = report.summary
  const e = s.entities
  const changed = !sameResolutions(applied, draft)
  const projection = changed ? projectedRate(report, applied, draft) : null
  const rate = projection ? projection.rate : s.matchRate
  const verdict = VERDICT_META[s.verdict]
  const VerdictIcon = verdict.icon
  const layerNames = Object.fromEntries(report.layers.map(l => [l.id, l.name ?? l.id]))
  const anchors = s.byKind.anchor
  const missingTypes = report.types.entity.some(t => t.status === 'missing') || report.types.relationship.some(t => t.status === 'missing')
  const typesUnchecked = report.notices.some(n => n.code === 'ontology_unavailable')

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row items-center gap-6 rounded-2xl border border-glass-border bg-gradient-to-br from-black/[0.015] to-transparent dark:from-white/[0.02] p-5">
        <MatchScoreRing rate={rate} verdict={s.verdict} projected={!!projection} />
        <div className="min-w-0 flex-1 space-y-2.5">
          <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold', verdict.cls)}>
            <VerdictIcon className="w-3.5 h-3.5" /> {verdict.label}
          </span>
          <p className="text-sm text-ink leading-relaxed">{s.verdictReason}</p>
          <p className="text-xs text-ink-muted">
            {e.found.toLocaleString()} of {e.checked.toLocaleString()} entities found
            {e.unknown ? `, ${e.unknown.toLocaleString()} not checked` : ''}
            {projection?.pending ? ` · ${pluralize(projection.pending, 'change')} to check` : ''}
          </p>
          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            <span className="rounded-lg bg-black/[0.04] dark:bg-white/[0.06] px-2 py-1 text-ink-secondary truncate max-w-[45%]" title={sourceLabel}>{sourceLabel}</span>
            <ArrowRight className="w-3.5 h-3.5 text-ink-muted" />
            <span className="rounded-lg bg-indigo-500/10 px-2 py-1 font-semibold text-indigo-700 dark:text-indigo-300 truncate max-w-[45%]" title={targetLabel}>{targetLabel}</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2.5">
        <CategoryCard icon={<Link2 className="w-3.5 h-3.5" />} label="Entities" value={e.found} total={e.checked}
          note={e.missing ? `${e.missing.toLocaleString()} not found` : undefined} />
        <CategoryCard icon={<Anchor className="w-3.5 h-3.5" />} label="Anchors" value={anchors?.found ?? 0} total={anchors?.checked ?? 0} />
        <CategoryCard icon={<Shapes className="w-3.5 h-3.5" />} label="Entity types"
          value={s.entityTypes.total - s.entityTypes.missing} total={s.entityTypes.total} unknown={typesUnchecked} />
        <CategoryCard icon={<GitFork className="w-3.5 h-3.5" />} label="Relationship types"
          value={s.relationshipTypes.total - s.relationshipTypes.missing} total={s.relationshipTypes.total} unknown={typesUnchecked} />
        <CategoryCard icon={<Layers className="w-3.5 h-3.5" />} label="Healthy layers" value={s.layers.healthy} total={s.layers.total} />
        <CategoryCard icon={<Palette className="w-3.5 h-3.5" />} label="Display rules" value={s.displayRules} note="carried over" />
      </div>

      {report.notices.length > 0 && (
        <div className="space-y-1.5">
          {report.notices.map(n => <Notice key={n.code} notice={n} />)}
        </div>
      )}

      {update && onStrategy && (
        <UpdatePanel update={update} targetName={targetName ?? targetLabel} onStrategy={onStrategy} />
      )}

      {missingTypes && (
        <section className="space-y-2">
          <SectionTitle title="Types that don't exist here" detail="Map each to a type this data source has, or take it out of the view." />
          <TypeMappingTable entityTypes={report.types.entity} relationshipTypes={report.types.relationship}
            available={availableTypes} draft={draft} onDraft={onDraft} />
        </section>
      )}

      {report.layers.length > 0 && (
        <section className="space-y-2">
          <SectionTitle title="Layers" detail="How much of each layer's placements are here." />
          <div className="rounded-xl border border-glass-border divide-y divide-glass-border">
            {report.layers.map(layer => {
              const placed = layer.total
              const pct = (n: number) => (placed ? (n / placed) * 100 : 0)
              return (
                <div key={layer.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: layer.color ?? '#94a3b8' }} />
                  <span className="text-xs font-medium text-ink w-40 truncate">{layer.name ?? layer.id}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-black/[0.06] dark:bg-white/[0.08] overflow-hidden flex">
                    <div className="bg-emerald-500" style={{ width: `${pct(layer.found)}%` }} />
                    <div className="bg-rose-400" style={{ width: `${pct(layer.missing)}%` }} />
                    <div className="bg-slate-400" style={{ width: `${pct(layer.unknown)}%` }} />
                  </div>
                  <span className="text-[11px] text-ink-muted tabular-nums w-28 text-right">
                    {placed ? `${layer.found.toLocaleString()} / ${placed.toLocaleString()} found` : 'No placements'}
                  </span>
                  {layer.anchor && (
                    <span title={`Anchor ${layer.anchor.urn}: ${layer.anchor.status.replace('_', ' ')}`}
                      className={cn('shrink-0', layer.anchor.status === 'missing' ? 'text-rose-500' : 'text-emerald-500')}>
                      <Anchor className="w-3.5 h-3.5" />
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <SectionTitle title="Entities to review"
          detail={`Kept by default: an entity that isn't here stays in the view, marked not found, and shows up if it appears later. ${percent(s.coverage, 0)} could be checked.`} />
        <ExceptionsTable entities={report.entities} truncated={report.entitiesTruncated} draft={draft} onDraft={onDraft}
          applied={applied} layerNames={layerNames} exportedNames={exportedNames} searchScope={searchScope} />
      </section>
    </div>
  )
}

function SectionTitle({ title, detail }: { title: string; detail?: string }) {
  return (
    <div>
      <h4 className="text-sm font-bold text-ink">{title}</h4>
      {detail && <p className="text-[11px] text-ink-muted mt-0.5">{detail}</p>}
    </div>
  )
}

function CategoryCard({ icon, label, value, total, note, unknown }: {
  icon: React.ReactNode
  label: string
  value: number
  total?: number
  note?: string
  unknown?: boolean
}) {
  const ratio = total ? value / total : null
  const tone = ratio === null ? 'bg-indigo-500' : ratio >= 0.95 ? 'bg-emerald-500' : ratio >= 0.5 ? 'bg-amber-500' : 'bg-rose-500'
  return (
    <div className="rounded-xl border border-glass-border bg-canvas-elevated px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-ink-muted">{icon}{label}</p>
      <p className="text-lg font-bold text-ink tabular-nums mt-0.5">
        {unknown ? '—' : value.toLocaleString()}
        {total !== undefined && !unknown && <span className="text-xs font-medium text-ink-muted"> / {total.toLocaleString()}</span>}
      </p>
      {total !== undefined && !unknown ? (
        <div className="h-1 rounded-full bg-black/[0.06] dark:bg-white/[0.08] mt-1.5 overflow-hidden">
          <div className={cn('h-full rounded-full', tone)} style={{ width: `${Math.max(total ? 2 : 0, (ratio ?? 0) * 100)}%` }} />
        </div>
      ) : (
        <p className="text-[10px] text-ink-muted mt-1">{unknown ? "couldn't be checked" : note}</p>
      )}
      {note && total !== undefined && !unknown && <p className="text-[10px] text-ink-muted mt-1">{note}</p>}
    </div>
  )
}

function Notice({ notice }: { notice: ReconcileNotice }) {
  const tone = notice.severity === 'error' ? 'bg-rose-500/[0.07] border-rose-500/20 text-rose-800 dark:text-rose-200'
    : notice.severity === 'warning' ? 'bg-amber-500/[0.07] border-amber-500/20 text-amber-800 dark:text-amber-200'
      : 'bg-indigo-500/[0.05] border-indigo-500/15 text-indigo-800 dark:text-indigo-200'
  return (
    <p className={cn('flex items-start gap-2 rounded-xl border px-3 py-2 text-[11px]', tone)}>
      <Info className="w-3.5 h-3.5 mt-px shrink-0" /> {notice.message}
    </p>
  )
}
