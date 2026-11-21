/**
 * Step 3 — Review: what the change will do, counted exactly before it is applied — how many
 * entities it changes, whose values it replaces, which it leaves alone — with a few of them by
 * name, anything that would stop it (a name the platform keeps, the property-name ceiling, another
 * change still running on the draft), and how it lands: on the draft, a window of entities at a
 * time, in its counts and catalog as each window does. A clean-up's count is a bound until it runs.
 * An optional reason is kept as the change's message — in the draft's history, and in the audit of
 * its publish.
 */
import { AlertTriangle, Ban, GitBranch, Info, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { Skeleton } from '@/components/ui/Skeleton'
import type { AffectedSample } from '@/services/propertyInsights'
import type { PropertyJobPreview } from '@/services/versioningApiService'
import {
  OP_LABEL, isCleanup, jobOp, needsTo, needsValue, propertyJobLabel, targetLabel, type Impact, type OpDraft, type ScopeMode, type TargetPreset,
} from './opModel'
import { FIELD, LABEL } from './styles'
import type { ReviewCounts } from './useReviewCounts'

export type { Impact } from './opModel'

export function ReviewStep({
  op, preset, scopeMode, counts, impact, exact, preview, previewLoading, sample, sampleLoading, stagedCount, reason = '', onReason,
  edges = false,
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
  /** Why it is made — kept as its message, in the draft's history and the publish's audit. */
  reason?: string
  onReason?: (reason: string) => void
  /** It changes relationships, not entities. */
  edges?: boolean
}) {
  const budget = preview?.nameBudget
  const noun = edges ? 'relationship' : 'entity'
  const derived = preview?.counts?.derived ?? 0
  const newName = needsTo(op.kind) ? op.to.trim() : op.key.trim()
  // On a draft, why a count is the published graph's rather than the draft's.
  const approximate = counts ? [...counts.counts.values()].find((c) => c.approximate)?.note ?? null : null
  const cleanup = isCleanup(op.kind)
  const unconvertible = preview?.counts?.unconvertible
  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-ink">
        {cleanup ? <span className="font-semibold">{propertyJobLabel(jobOp(op))}</span> : (
          <>
            <span className="font-semibold">{OP_LABEL[op.kind]}</span>{' '}
            <span className="font-mono">{op.key.trim()}</span>
            {needsTo(op.kind) && <> → <span className="font-mono">{op.to.trim()}</span></>}
            {needsValue(op.kind) && <> = <span className="font-mono">{String(op.value)}</span></>}
          </>
        )}
        {' '}on {targetLabel(preset)}{preset.kind !== 'selection' && preset.kind !== 'relationships' && scopeMode === 'data_source' ? ', across the whole data source' : ''}.
      </p>

      <div className="grid grid-cols-3 gap-2" aria-live="polite">
        <Tile label="Will change" value={impact?.changes} tone="accent" upTo={impact?.upTo} />
        <Tile label={cleanup ? 'Values rewritten' : op.kind === 'set' || needsTo(op.kind) ? 'Values replaced' : 'Replaced'} value={impact?.replaced}
          tone={impact?.replaced ? 'warning' : 'neutral'} upTo={impact?.upTo} />
        <Tile label="Left as they are" value={impact?.untouched} tone="neutral" />
      </div>
      {impact?.upTo && (
        <p className="flex items-start gap-1.5 text-[11px] text-ink-muted">
          <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden /> At most: what it changes is known as each entity is read — the job says exactly when it ends.
        </p>
      )}
      {op.kind === 'convert' && (
        <Notice tone={unconvertible ? 'warning' : 'neutral'} icon={unconvertible ? AlertTriangle : Info}>
          {unconvertible ? <>{unconvertible.toLocaleString()} of them hold a value that won’t convert. </> : null}
          {(op.onFail ?? 'skip') === 'remove'
            ? <>A value that won’t convert is removed; the job counts them.</>
            : <>A value that won’t convert is left as it is; the job lists each one when it ends (<span className="font-semibold">Which, and why</span>).</>}
        </Notice>
      )}
      {counts && !counts.complete && !counts.error && !counts.unavailable && (
        <div className="flex items-center gap-2 text-[11px] text-ink-muted">
          <ProgressBar value={counts.percent} label="Counting the entities" className="w-32" />
          Counting every {noun}{scopeMode === 'data_source' ? ' in the data source' : ' in the view'}… {Math.round(counts.percent)}%
        </div>
      )}
      {counts?.error && (
        <p className="flex items-start gap-1.5 text-[11.5px] text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden /> {counts.error} — the numbers are what was counted before it stopped.
        </p>
      )}
      {approximate && (
        <p className="flex items-start gap-1.5 text-[11.5px] text-ink-muted">
          <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden /> Some of these are the published graph’s counts: {approximate}
        </p>
      )}
      {exact && impact?.changes === 0 && (
        <p className="flex items-start gap-1.5 text-[11.5px] text-ink-muted">
          <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden /> Nothing would change — none of these {edges ? 'relationships' : 'entities'} would end up different.
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
      {derived > 0 && (
        <Notice tone="neutral" icon={Info}>
          {derived.toLocaleString()} of them {derived === 1 ? 'is a roll-up' : 'are roll-ups'} — a summary the aggregation computes — and {derived === 1 ? 'is' : 'are'} left as {derived === 1 ? 'it is' : 'they are'}.
        </Notice>
      )}
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

      {onReason && (
        <div>
          <label className={LABEL} htmlFor="op-reason">Reason <span className="normal-case tracking-normal font-normal">(optional)</span></label>
          <input id="op-reason" value={reason} onChange={(e) => onReason(e.target.value)} maxLength={2000}
            placeholder="e.g. One spelling of each department, per the data owners" className={FIELD} />
          <p className="mt-1 text-[11px] text-ink-muted">Kept with the change: in the draft’s history, and in the audit of the publish that takes it to Published.</p>
        </div>
      )}

      <div className="flex items-start gap-2 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] p-2.5 text-[11.5px] leading-snug text-ink-secondary">
        <GitBranch className="mt-px h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />
        {edges ? (
          <span>
            Applied to your draft by the server — every relationship it reaches, however many, a batch at a time — and
            published from there. Roll-ups are never changed: they follow the relationships they summarise.
          </span>
        ) : (
          <span>
            Applied to your draft by the server — every matching entity, however many, a batch at a time — and
            published from there. The entities are found as published; ones new in this draft aren’t matched (select
            them on the canvas instead). Counts, rule tags and the catalog follow your draft, batch by batch.
          </span>
        )}
      </div>
    </div>
  )
}

function Tile({ label, value, tone, upTo }: { label: string; value: number | undefined; tone: 'accent' | 'warning' | 'neutral'; upTo?: boolean }) {
  return (
    <div className={cn('rounded-xl border px-3 py-2',
      tone === 'accent' ? 'border-accent-lineage/30 bg-accent-lineage/[0.05]'
        : tone === 'warning' ? 'border-amber-500/30 bg-amber-500/[0.06]' : 'border-black/[0.07] dark:border-white/[0.08]')}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted">{label}</div>
      {value === undefined ? <Skeleton className="mt-1 h-5 w-14" /> : (
        <div className={cn('mt-0.5 text-lg font-semibold tabular-nums',
          tone === 'accent' ? 'text-accent-lineage' : tone === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-ink')}>
          {upTo && <span className="mr-1 text-[11px] font-medium text-ink-muted">up to</span>}
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

