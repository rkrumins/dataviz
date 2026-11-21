/**
 * Step 3 — Review: what the change will do, counted exactly before it is applied — how many
 * entities it changes, whose values it replaces, which it leaves alone — with a few of them by
 * name, anything that would stop it (a name the platform keeps, the property-name ceiling, another
 * change still running on the draft), and how it lands: on the draft, a window of entities at a
 * time, in counts after publish.
 */
import { AlertTriangle, Ban, GitBranch, Info, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { Skeleton } from '@/components/ui/Skeleton'
import type { AffectedSample } from '@/services/propertyInsights'
import type { PropertyJobPreview } from '@/services/versioningApiService'
import { OP_LABEL, needsTo, needsValue, targetLabel, type OpDraft, type ScopeMode, type TargetPreset } from './opModel'
import type { ReviewCounts } from './useReviewCounts'

export interface Impact { changes: number; replaced: number; untouched: number }

export function ReviewStep({
  op, preset, scopeMode, counts, impact, exact, preview, previewLoading, sample, sampleLoading, stagedCount,
}: {
  op: OpDraft
  preset: TargetPreset
  scopeMode: ScopeMode
  counts: ReviewCounts | null
  impact: Impact | null
  /** The impact's counts are final. */
  exact: boolean
  preview: PropertyJobPreview | null
  previewLoading: boolean
  sample: AffectedSample | null
  sampleLoading: boolean
  stagedCount: number
}) {
  const budget = preview?.nameBudget
  const newName = needsTo(op.kind) ? op.to.trim() : op.key.trim()
  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-ink">
        <span className="font-semibold">{OP_LABEL[op.kind]}</span>{' '}
        <span className="font-mono">{op.key.trim()}</span>
        {needsTo(op.kind) && <> → <span className="font-mono">{op.to.trim()}</span></>}
        {needsValue(op.kind) && <> = <span className="font-mono">{String(op.value)}</span></>}
        {' '}on {targetLabel(preset)}{preset.kind !== 'selection' && scopeMode === 'data_source' ? ', across the whole data source' : ''}.
      </p>

      <div className="grid grid-cols-3 gap-2" aria-live="polite">
        <Tile label="Will change" value={impact?.changes} tone="accent" />
        <Tile label={op.kind === 'set' || needsTo(op.kind) ? 'Values replaced' : 'Replaced'} value={impact?.replaced} tone={impact?.replaced ? 'warning' : 'neutral'} />
        <Tile label="Left as they are" value={impact?.untouched} tone="neutral" />
      </div>
      {counts && !counts.complete && !counts.error && !counts.unavailable && (
        <div className="flex items-center gap-2 text-[11px] text-ink-muted">
          <ProgressBar value={counts.percent} label="Counting the entities" className="w-32" />
          Counting every entity{scopeMode === 'data_source' ? ' in the data source' : ' in the view'}… {Math.round(counts.percent)}%
        </div>
      )}
      {counts?.error && (
        <p className="flex items-start gap-1.5 text-[11.5px] text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden /> {counts.error} — the numbers are what was counted before it stopped.
        </p>
      )}
      {exact && impact?.changes === 0 && (
        <p className="flex items-start gap-1.5 text-[11.5px] text-ink-muted">
          <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden /> Nothing would change — none of these entities would end up different.
        </p>
      )}

      {sampleLoading ? (
        <div className="flex gap-1.5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-5 w-24 rounded-md" />)}</div>
      ) : sample && sample.entities.length > 0 && (
        <div>
          <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted mb-1">Among them</span>
          <div className="flex flex-wrap gap-1">
            {sample.entities.map((e) => (
              <span key={e.urn} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] bg-black/[0.04] dark:bg-white/[0.06] max-w-[12rem]">
                <span className="truncate text-ink">{e.displayName}</span>
                {e.entityType && <span className="shrink-0 text-ink-muted">{e.entityType}</span>}
              </span>
            ))}
            {sample.truncated && <span className="self-center text-[11px] text-ink-muted">and more</span>}
          </div>
        </div>
      )}

      {previewLoading && <p className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted"><Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Checking it can be applied…</p>}
      {preview?.refusal && <Notice tone="danger" icon={Ban}>{preview.refusal.message}</Notice>}
      {preview?.activeJobId && <Notice tone="danger" icon={Ban}>Another change is still being applied to this draft. Wait for it to finish, then apply this one.</Notice>}
      {/* What publishing would refuse (the entity types' fields): said, never a block. */}
      {preview?.warnings?.map((w) => (
        <Notice key={`${w.code}:${w.entityType}:${w.field}`} tone="warning" icon={AlertTriangle}>{w.message}</Notice>
      ))}
      {budget?.verdict === 'refused' && (
        <Notice tone="danger" icon={Ban}>
          This graph has almost no room left for new property names, so <span className="font-mono">{newName}</span> can’t be added. Reuse a name it already holds.
        </Notice>
      )}
      {budget?.verdict === 'raw' && budget.isNew && (
        <Notice tone="warning" icon={AlertTriangle}>
          <span className="font-mono">{newName}</span> is a new name past the graph’s searchable-property budget: it is kept, but
          can’t be searched by value. {budget.registered !== null && <>({budget.registered.toLocaleString()} names in use.)</>}
        </Notice>
      )}
      {budget?.isNew && budget.verdict === 'ok' && needsTo(op.kind) && (
        <Notice tone="neutral" icon={Info}>
          A new property name stays registered in the graph even after it is renamed away — names are never freed.
        </Notice>
      )}
      {stagedCount > 0 && (
        <Notice tone="warning" icon={AlertTriangle}>
          You have {stagedCount.toLocaleString()} staged {stagedCount === 1 ? 'change' : 'changes'} not saved yet. Save them (Review &amp; Save) — or
          discard them — first, so this change and yours don’t meet halfway.
        </Notice>
      )}

      <div className="flex items-start gap-2 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] p-2.5 text-[11.5px] leading-snug text-ink-secondary">
        <GitBranch className="mt-px h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />
        <span>
          Applied to your draft by the server — every matching entity, however many, a batch at a time — and
          published from there. The entities are found as published; ones new in this draft aren’t matched (select
          them on the canvas instead). Counts and the catalog show the change once it is published.
        </span>
      </div>
    </div>
  )
}

function Tile({ label, value, tone }: { label: string; value: number | undefined; tone: 'accent' | 'warning' | 'neutral' }) {
  return (
    <div className={cn('rounded-xl border px-3 py-2',
      tone === 'accent' ? 'border-accent-lineage/30 bg-accent-lineage/[0.05]'
        : tone === 'warning' ? 'border-amber-500/30 bg-amber-500/[0.06]' : 'border-black/[0.07] dark:border-white/[0.08]')}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted">{label}</div>
      {value === undefined ? <Skeleton className="mt-1 h-5 w-14" /> : (
        <div className={cn('mt-0.5 text-lg font-semibold tabular-nums',
          tone === 'accent' ? 'text-accent-lineage' : tone === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-ink')}>
          {value.toLocaleString()}
        </div>
      )}
    </div>
  )
}

function Notice({ tone, icon: Icon, children }: { tone: 'danger' | 'warning' | 'neutral'; icon: typeof Info; children: React.ReactNode }) {
  return (
    <div role={tone === 'danger' ? 'alert' : undefined} className={cn('flex items-start gap-2 rounded-lg border p-2.5 text-[11.5px] leading-snug',
      tone === 'danger' ? 'border-rose-500/35 bg-rose-500/[0.06] text-rose-800 dark:text-rose-200'
        : tone === 'warning' ? 'border-amber-500/35 bg-amber-500/[0.06] text-amber-800 dark:text-amber-200'
          : 'border-black/[0.07] dark:border-white/[0.08] text-ink-secondary')}>
      <Icon className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </div>
  )
}

