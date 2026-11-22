/**
 * Step 3 — Review: what the change will do, counted exactly before it is applied — how many
 * entities it changes, whose values it replaces, which it leaves alone — with a few of them by
 * name, anything that would stop it (a name the platform keeps, the property-name ceiling, another
 * change still running on the draft), and how it lands: on the draft, a window of entities at a
 * time, in its counts and catalog as each window does. A clean-up's count is a bound until it runs.
 * An optional reason is kept as the change's message — in the draft's history, and in the audit of
 * its publish.
 *
 * In sections: Impact (the counts), Checks (what stops it first, then warnings, then notes — the
 * first few, the rest a click away), Sample (some of them by name and type), and Details (the reason,
 * and keeping it for reuse). How it lands is a footnote.
 */
import { useId, useState, type ReactNode } from 'react'
import { AlertTriangle, Ban, GitBranch, Info, Loader2, RotateCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { Skeleton } from '@/components/ui/Skeleton'
import type { AffectedSample } from '@/services/propertyInsights'
import type { PropertyJobPreview, PropertyOpKind } from '@/services/versioningApiService'
import {
  DRAFT_LARGE, OP_LABEL, isCleanup, jobOp, needsTo, needsValue, propertyJobLabel, scopedTargetLabel, type Impact, type OpDraft, type ScopeMode,
  type TargetPreset,
} from './opModel'
import { SaveForReuse } from './SaveForReuse'
import { FIELD, LABEL } from './styles'
import type { ReviewCounts } from './useReviewCounts'

export type { Impact } from './opModel'

/** Checks shown before the rest are asked for. */
const CHECKS_SHOWN = 3

/** The reason's example, fitting the change: why someone would make it. */
const REASON_EXAMPLE: Record<PropertyOpKind, string> = {
  set: 'e.g. The data platform team owns these now',
  fillEmpty: 'e.g. Left empty by the last import',
  rename: 'e.g. One name for this property across every source',
  copy: 'e.g. Kept under the old name while dashboards move',
  remove: 'e.g. No longer used since the catalog moved',
  replace: 'e.g. The Ops team is now called Platform',
  normalize: 'e.g. Stray spaces and mixed case from the CSV import',
  mapValues: 'e.g. One spelling of each department, per the data owners',
  convert: 'e.g. Retention is a number of days, not text',
}

export function ReviewStep({
  op, preset, scopeMode, counts, impact, exact, preview, previewLoading, previewError = null, onRetry, sample, sampleLoading, stagedCount,
  reason = '', onReason, edges = false, onFollow, onChangeTarget, draftChanges, offerSave = true,
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
  /** Why the server's check of it failed — it can't be applied until a check answers. */
  previewError?: string | null
  /** Check and count it again. */
  onRetry?: () => void
  sample: AffectedSample | null
  sampleLoading: boolean
  stagedCount: number
  /** How many entities the draft has changed already, where it's known. */
  draftChanges?: number
  /** Why it is made — kept as its message, in the draft's history and the publish's audit. */
  reason?: string
  onReason?: (reason: string) => void
  /** It changes relationships, not entities. */
  edges?: boolean
  /** Follow the change already running on the draft, in Property Manager. */
  onFollow?: (jobId: string) => void
  /** Go back and choose another target. */
  onChangeTarget?: () => void
  /** Offer to keep it for reuse (not for a reusable change run as it was kept). */
  offerSave?: boolean
}) {
  const budget = preview?.nameBudget
  const noun = edges ? 'relationship' : 'entity'
  const derived = preview?.counts?.derived ?? 0
  const newName = needsTo(op.kind) ? op.to.trim() : op.key.trim()
  // On a draft, why a count is the published graph's rather than the draft's.
  const approximate = counts ? [...counts.counts.values()].find((c) => c.approximate)?.note ?? null : null
  const cleanup = isCleanup(op.kind)
  const unconvertible = preview?.counts?.unconvertible
  // Still counting (or stopped short): the numbers are what has been counted so far.
  const soFar = !!counts && !counts.complete && !counts.unavailable
  // The second count, as the operation has one: a fill never replaces, a removal removes.
  const second = op.kind === 'fillEmpty' ? null
    : op.kind === 'remove' ? { label: 'Values removed', value: impact?.changes }
      : { label: cleanup ? 'Values rewritten' : 'Values replaced', value: impact?.replaced }
  // What the server's check says, most pressing first: what stops it, then what to know, then notes.
  const blocking: ReactNode[] = []
  const warnings: ReactNode[] = []
  const notes: ReactNode[] = []
  if (previewError) {
    blocking.push(
      <Notice key="check" tone="danger" icon={Ban} action={onRetry && <RetryButton onClick={onRetry} />}>
        Couldn’t check it can be applied: {previewError}
      </Notice>,
    )
  }
  if (preview?.refusal) {
    blocking.push(
      <Notice key="refusal" tone="danger" icon={Ban} action={preview.refusal.code === 'too_many_ids' && onChangeTarget
        ? <NoticeButton onClick={onChangeTarget}>Choose another target</NoticeButton> : undefined}>
        {preview.refusal.message}
      </Notice>,
    )
  }
  if (preview?.activeJobId) {
    blocking.push(
      <Notice key="active" tone="danger" icon={Ban} action={onFollow && <NoticeButton onClick={() => onFollow(preview.activeJobId!)}>Follow it</NoticeButton>}>
        Another change is still being applied to this draft. Wait for it to finish, then apply this one.
      </Notice>,
    )
  }
  if (budget?.verdict === 'refused') {
    blocking.push(
      <Notice key="budget" tone="danger" icon={Ban}>
        This graph has almost no room left for new property names, so <span className="font-mono">{newName}</span> can’t be added. Reuse a name it already holds.
      </Notice>,
    )
  }
  if (stagedCount > 0) {
    blocking.push(
      <Notice key="staged" tone="danger" icon={Ban}>
        You have {stagedCount.toLocaleString()} staged {stagedCount === 1 ? 'change' : 'changes'} not saved yet. Save them (Review &amp; Save) — or
        discard them — first, so this change and yours don’t meet halfway.
      </Notice>,
    )
  }
  if (op.kind === 'convert') {
    (unconvertible ? warnings : notes).push(
      <Notice key="convert" tone={unconvertible ? 'warning' : 'neutral'} icon={unconvertible ? AlertTriangle : Info}>
        {unconvertible ? <>{unconvertible.toLocaleString()} of them hold a value that won’t convert. </> : null}
        {(op.onFail ?? 'skip') === 'remove'
          ? <>A value that won’t convert is removed; the job counts them.</>
          : <>A value that won’t convert is left as it is; the job lists each one when it ends (<span className="font-semibold">Which, and why</span>).</>}
      </Notice>,
    )
  }
  // What publishing would refuse (the entity types' fields): said, never a block.
  for (const w of preview?.warnings ?? []) {
    warnings.push(<Notice key={`${w.code}:${w.entityType}:${w.field}`} tone="warning" icon={AlertTriangle}>{w.message}</Notice>)
  }
  if (budget?.verdict === 'raw' && budget.isNew) {
    warnings.push(
      <Notice key="raw" tone="warning" icon={AlertTriangle}>
        <span className="font-mono">{newName}</span> is a new name past the graph’s searchable-property budget: it is kept, but
        can’t be searched by value. {budget.registered !== null && <>({budget.registered.toLocaleString()} names in use.)</>}
      </Notice>,
    )
  }
  if (draftChanges !== undefined && impact && draftChanges + impact.changes > DRAFT_LARGE) {
    warnings.push(
      <Notice key="large" tone="warning" icon={AlertTriangle}>
        Your draft will hold about {(draftChanges + impact.changes).toLocaleString()} changed entities. Past {DRAFT_LARGE.toLocaleString()},
        its counts and property list show the published graph, and it is slower to open — publish it in parts to keep it quick.
      </Notice>,
    )
  }
  if (derived > 0) {
    notes.push(
      <Notice key="derived" tone="neutral" icon={Info}>
        {derived.toLocaleString()} of them {derived === 1 ? 'is a roll-up' : 'are roll-ups'} — a summary the aggregation computes — and {derived === 1 ? 'is' : 'are'} left as {derived === 1 ? 'it is' : 'they are'}.
      </Notice>,
    )
  }
  if (budget?.isNew && budget.verdict === 'ok' && needsTo(op.kind)) {
    notes.push(
      <Notice key="name" tone="neutral" icon={Info}>
        A new property name stays registered in the graph even after it is renamed away — names are never freed.
      </Notice>,
    )
  }
  const checks = [...blocking, ...warnings, ...notes]
  const [allChecks, setAllChecks] = useState(false)
  // A few at first, never hiding one that stops it.
  const shownChecks = allChecks ? checks : checks.slice(0, Math.max(CHECKS_SHOWN, blocking.length))

  return (
    <div className="space-y-7">
      <p className="text-[15px] leading-relaxed text-ink">
        {cleanup ? <span className="font-semibold">{propertyJobLabel(jobOp(op))}</span> : (
          <>
            <span className="font-semibold">{OP_LABEL[op.kind]}</span>{' '}
            <span className="font-mono">{op.key.trim()}</span>
            {needsTo(op.kind) && <> → <span className="font-mono">{op.to.trim()}</span></>}
            {needsValue(op.kind) && <> = <span className="font-mono">{String(op.value)}</span></>}
          </>
        )}
        {' '}on {scopedTargetLabel(preset, scopeMode)}.
      </p>

      <Section title="Impact">
        {counts?.unavailable ? (
          <Notice tone="neutral" icon={Info}>
            <span className="font-semibold text-ink">Can’t be counted here.</span> The job counts what it changes as it goes, and says
            how many when it ends.
          </Notice>
        ) : (
          <div className={cn('grid grid-cols-1 gap-2 sm:gap-3', second ? 'sm:grid-cols-3' : 'sm:grid-cols-2')} aria-live="polite">
            <Tile label="Will change" value={impact?.changes} tone="accent" upTo={impact?.upTo} soFar={soFar} />
            {second && (
              <Tile label={second.label} value={second.value} tone={second.value ? 'warning' : 'neutral'} upTo={impact?.upTo} soFar={soFar} />
            )}
            <Tile label="Left as they are" value={impact?.untouched} tone="neutral" soFar={soFar} />
          </div>
        )}
        {impact?.upTo && (
          <p className="flex items-start gap-1.5 text-xs text-ink-muted">
            <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden /> At most: what it changes is known as each entity is read — the job says exactly when it ends.
          </p>
        )}
        {counts && !counts.complete && !counts.error && !counts.unavailable && (
          <div className="flex items-center gap-2 text-xs text-ink-muted">
            <ProgressBar value={counts.percent} label="Counting the entities" className="w-32 shrink-0 bg-black/[0.08] dark:bg-white/[0.10]" />
            Counting every {noun}{scopeMode === 'data_source' ? ' in the data source' : ' in the view'}… {Math.round(counts.percent)}%
          </div>
        )}
        {counts?.error && (
          <Notice tone="warning" icon={AlertTriangle} action={onRetry && <RetryButton onClick={onRetry} />}>
            {counts.error} — the numbers are what was counted before it stopped, so it can’t be applied until a count finishes.
          </Notice>
        )}
        {approximate && (
          <p className="flex items-start gap-1.5 text-xs text-ink-muted">
            <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden /> Some of these are the published graph’s counts: {approximate}
          </p>
        )}
        {exact && impact?.changes === 0 && (
          <p className="flex items-start gap-1.5 text-xs text-ink-muted">
            <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden /> Nothing would change — none of these {edges ? 'relationships' : 'entities'} would end up different.
          </p>
        )}
      </Section>

      {(previewLoading || preview || checks.length > 0) && (
        <Section title="Checks">
          {previewLoading && <p className="inline-flex items-center gap-1.5 text-xs text-ink-muted"><Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Checking it can be applied…</p>}
          {!previewLoading && checks.length === 0 && (
            <p className="flex items-start gap-1.5 text-[13px] text-ink-secondary">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden /> The server found nothing that would stop it.
            </p>
          )}
          {shownChecks}
          {shownChecks.length < checks.length && (
            <Button size="sm" variant="ghost" className="-ml-2.5" onClick={() => setAllChecks(true)}>Show all {checks.length.toLocaleString()}</Button>
          )}
        </Section>
      )}

      {(sampleLoading || (sample && sample.entities.length > 0)) && (
        <Section title="Sample">
          {sampleLoading ? (
            <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-5 w-full rounded-md" />)}</div>
          ) : sample && (
            <>
              <ul className="grid gap-x-6 sm:grid-cols-2" aria-label={`Some of the ${edges ? 'relationships' : 'entities'} it reaches`}>
                {sample.entities.map((e) => (
                  <li key={e.urn} className="flex min-w-0 items-baseline justify-between gap-3 border-b border-black/[0.05] py-1.5 text-[13px] dark:border-white/[0.06]">
                    <span className="truncate text-ink">{e.displayName}</span>
                    {e.entityType && <span className="shrink-0 text-xs text-ink-muted">{e.entityType}</span>}
                  </li>
                ))}
              </ul>
              {sample.truncated && <p className="text-xs text-ink-muted">A few of them — there are more.</p>}
            </>
          )}
        </Section>
      )}

      {(onReason || offerSave) && (
        <Section title="Details">
          <div className="flex flex-col gap-5 md:flex-row md:items-start">
            {onReason && (
              <div className="min-w-0 flex-1">
                <label className={LABEL} htmlFor="op-reason">Reason <span className="normal-case tracking-normal font-normal">(optional)</span></label>
                <input id="op-reason" value={reason} onChange={(e) => onReason(e.target.value)} maxLength={2000}
                  placeholder={REASON_EXAMPLE[op.kind]} className={FIELD} />
                <p className="mt-1.5 text-xs text-ink-muted">Kept with the change: in the draft’s history, and in the audit of the publish that takes it to Published.</p>
              </div>
            )}
            {offerSave && <SaveForReuse op={op} preset={preset} scopeMode={scopeMode} className="md:w-64 md:shrink-0" />}
          </div>
        </Section>
      )}

      <p className="flex items-start gap-2 border-t border-black/[0.06] pt-4 text-xs leading-relaxed text-ink-muted dark:border-white/[0.06]">
        <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        {edges ? (
          <span>
            Applied to your draft by the server — every relationship it reaches, however many, a batch at a time — and
            published from there. Roll-ups are never changed: they follow the relationships they summarise.
          </span>
        ) : preset.kind === 'selection' ? (
          <span>
            Applied to your draft by the server, a batch at a time, and published from there. These entities are found
            by id on your draft — ones new in it too. Counts, rule tags and the catalog follow your draft, batch by batch.
          </span>
        ) : (
          <span>
            Applied to your draft by the server — every matching entity, however many, a batch at a time — and
            published from there. The entities are found as published; ones new in this draft aren’t matched (select
            them on the canvas instead). Counts, rule tags and the catalog follow your draft, batch by batch.
          </span>
        )}
      </p>
    </div>
  )
}

/** One part of Review, under a small heading. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h4 id={id} className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">{title}</h4>
      {children}
    </section>
  )
}

function Tile({ label, value, tone, upTo, soFar }: {
  label: string; value: number | undefined; tone: 'accent' | 'warning' | 'neutral'; upTo?: boolean
  /** Still being counted: the number so far. */
  soFar?: boolean
}) {
  // A row of its own on a phone, a tile beside the others on anything wider.
  return (
    <div className={cn('flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5 sm:block sm:py-3',
      tone === 'accent' ? 'border-accent-lineage/30 bg-accent-lineage/[0.05]'
        : tone === 'warning' ? 'border-amber-500/30 bg-amber-500/[0.06]' : 'border-black/[0.07] dark:border-white/[0.08]')}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">{label}</div>
      {value === undefined ? <Skeleton className="h-7 w-16 sm:mt-1.5" /> : (
        <div className={cn('text-xl font-semibold tabular-nums sm:mt-1 sm:text-2xl',
          tone === 'accent' ? 'text-accent-lineage' : tone === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-ink')}>
          {upTo && <span className="mr-1 text-xs font-medium text-ink-muted">up to</span>}
          {value.toLocaleString()}
          {soFar && <span className="ml-1 text-xs font-medium text-ink-muted">so far</span>}
        </div>
      )}
    </div>
  )
}

function Notice({ tone, icon: Icon, children, action }: {
  tone: 'danger' | 'warning' | 'neutral'; icon: typeof Info; children: React.ReactNode
  /** The next step it offers. */
  action?: React.ReactNode
}) {
  return (
    <div role={tone === 'danger' ? 'alert' : undefined} className={cn('flex items-start gap-2 rounded-lg border p-3 text-[13px] leading-snug',
      tone === 'danger' ? 'border-rose-500/35 bg-rose-500/[0.06] text-rose-800 dark:text-rose-200'
        : tone === 'warning' ? 'border-amber-500/35 bg-amber-500/[0.06] text-amber-800 dark:text-amber-200'
          : 'border-black/[0.07] dark:border-white/[0.08] text-ink-secondary')}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  )
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return <Button size="sm" variant="ghost" leftIcon={RotateCw} className="-my-1 h-7 shrink-0 px-2 text-xs" onClick={onClick}>Try again</Button>
}

function NoticeButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return <Button size="sm" variant="ghost" className="-my-1 h-7 shrink-0 px-2 text-xs" onClick={onClick}>{children}</Button>
}
