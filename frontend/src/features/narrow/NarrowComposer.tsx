/**
 * NarrowComposer — choose what the canvas shows: some entities, and how far
 * they reach.
 *
 * Starting points are the entities chosen (removable, one by one) or the search
 * that finds them. How far they reach is one of the common shapes, as cards, or
 * fine-tuned part by part: what is inside them, their sources and consumers to a
 * number of steps or the whole way, and what is inside those. Every part shows
 * what it adds as the reach changes, the preview spreads the answer over the
 * view's layers, and every limit the answer reached is said in words — nothing
 * is applied blind.
 *
 * The answer is worked out on the server and shared with everyone asking the
 * same thing (`useNarrowResolve`), so the preview IS what Narrow applies.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'

import { Backdrop } from '@/components/ui/Backdrop'
import { Kbd } from '@/components/ui/Kbd'
import { Segmented } from '@/components/ui/Segmented'
import { MOTION } from '@/lib/motion'
import { cn } from '@/lib/utils'
import type { Depth, MembershipExpand, MembershipResult, MembershipSpec } from '@/types/membership'

import {
  describeNarrow,
  HOPS_MAX,
  layerDistribution,
  PRESETS,
  presetOf,
  seedsLabel as seedsLabelOf,
  truncationNotes,
  canRetry,
  type PresetId,
} from './model'
import type { NarrowDraft } from './narrowStore'
import { useNarrowResolve } from './useNarrowResolve'

export interface NarrowLayer {
  id: string
  name: string
  color: string
}

export interface NarrowComposerProps {
  viewId: string
  draft: NarrowDraft
  /** The Lineage trace switch: sources and consumers need it. */
  lineageEnabled: boolean
  layers: readonly NarrowLayer[]
  /** The layer an entity is drawn in, when the canvas has it. */
  layerOf: (urn: string) => string | undefined
  onApply: (draft: NarrowDraft, result: MembershipResult) => void
  onClose: () => void
  /** Keep what is chosen as a view of its own, without narrowing first; absent
   *  when it can't be (the preview is off, or views can't be created here). */
  onSaveAsView?: (draft: NarrowDraft) => void
}

const PRESET_ICONS: Record<PresetId, keyof typeof LucideIcons> = {
  just: 'Crosshair',
  'one-level': 'ListTree',
  'two-levels': 'FolderTree',
  neighbours: 'ArrowLeftRight',
  upstream: 'ArrowUpLeft',
  downstream: 'ArrowDownRight',
}

const n = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`

export function NarrowComposer({ viewId, draft, lineageEnabled, layers, layerOf, onApply, onClose, onSaveAsView }: NarrowComposerProps) {
  const [spec, setSpec] = useState<MembershipSpec>(draft.spec)
  // Sources and consumers with the Lineage trace off would only be refused: not asked.
  const lineageBlocked = !lineageEnabled && (spec.expand.upstream !== 0 || spec.expand.downstream !== 0)
  const { state, retry } = useNarrowResolve(viewId, lineageBlocked ? null : spec)
  const result = state.status === 'ready' ? state.result : state.status === 'loading' ? state.last : null
  const loading = state.status === 'loading'
  const urns = spec.seeds.urns
  const label = urns
    ? seedsLabelOf(urns, (u) => draft.seedNames?.[u] ?? u.split(/[:/]/).pop() ?? u)
    : draft.seedsLabel
  const sentence = describeNarrow(spec, label)
  const preset = presetOf(spec.expand)
  const ready = state.status === 'ready' && state.result.counts.total > 0 && !lineageBlocked

  const setExpand = (patch: Partial<MembershipExpand>) =>
    setSpec((s) => ({ ...s, expand: { ...s.expand, ...patch } }))
  const removeSeed = (urn: string) =>
    setSpec((s) => ({ ...s, seeds: { urns: (s.seeds.urns ?? []).filter((u) => u !== urn) } }))

  const apply = () => {
    if (!ready || state.status !== 'ready') return
    onApply({ ...draft, spec, seedsLabel: label }, state.result)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return createPortal(
    <>
      <Backdrop open={true} onClick={onClose} zClassName="z-50" className="bg-black/40 backdrop-blur-[2px]" />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-labelledby="narrow-composer-title"
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={MOTION.modalSpring}
          className="pointer-events-auto relative w-full max-w-2xl max-h-[calc(100vh-2rem)] flex flex-col rounded-2xl bg-canvas-elevated border border-glass-border shadow-2xl shadow-black/25 overflow-hidden"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); apply() } }}
        >
          {/* Header */}
          <div className="flex items-start justify-between px-7 pt-6 pb-4">
            <div className="flex items-center gap-3.5 min-w-0">
              <div className="w-11 h-11 rounded-2xl bg-accent-lineage/[0.12] border border-accent-lineage/25 flex items-center justify-center flex-none">
                <LucideIcons.ScanSearch className="w-5 h-5 text-accent-lineage" strokeWidth={2.2} />
              </div>
              <div className="min-w-0">
                <h2 id="narrow-composer-title" className="text-xl font-display font-semibold text-ink leading-tight">
                  Narrow the canvas
                </h2>
                <p className="text-[13px] text-ink-muted mt-0.5">Show only what you choose, and what it reaches. Nothing is saved or changed.</p>
              </div>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
              <LucideIcons.X className="w-5 h-5" />
            </button>
          </div>

          <div className="px-7 pb-6 space-y-5 overflow-y-auto">
            {/* Starting points */}
            <Section title="Starting from">
              {urns ? (
                <ul className="flex flex-wrap gap-1.5" aria-label="Starting points">
                  {urns.slice(0, 12).map((urn) => (
                    <li key={urn}>
                      <span className="inline-flex items-center gap-1 max-w-[14rem] pl-2.5 pr-1 py-1 rounded-lg bg-accent-lineage/10 border border-accent-lineage/25">
                        <span className="truncate text-[12.5px] text-ink" title={urn}>{draft.seedNames?.[urn] ?? urn.split(/[:/]/).pop()}</span>
                        <button
                          type="button"
                          onClick={() => removeSeed(urn)}
                          disabled={urns.length === 1}
                          aria-label={`Remove ${draft.seedNames?.[urn] ?? urn}`}
                          className="p-0.5 rounded-md text-ink-muted hover:text-ink hover:bg-black/10 dark:hover:bg-white/15 disabled:opacity-30 disabled:pointer-events-none"
                        >
                          <LucideIcons.X className="w-3 h-3" strokeWidth={2.4} />
                        </button>
                      </span>
                    </li>
                  ))}
                  {urns.length > 12 && (
                    <li className="self-center text-[12px] text-ink-muted">and {(urns.length - 12).toLocaleString()} more</li>
                  )}
                </ul>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-glass-border/70 px-4 py-3">
                  <span className="flex items-center gap-2 min-w-0 text-[13px] text-ink">
                    <LucideIcons.Search className="w-4 h-4 text-accent-lineage flex-none" />
                    <span className="truncate">{draft.seedsLabel}</span>
                    {result && (
                      <span className={cn('px-1.5 py-0.5 rounded-md bg-black/[0.05] dark:bg-white/[0.07] text-[11px] font-semibold tabular-nums text-ink-muted', loading && 'animate-pulse')}>
                        {n(result.counts.seeds, 'match', 'matches')}
                      </span>
                    )}
                  </span>
                  <Segmented
                    label="Where to look for matches"
                    value={spec.within}
                    onChange={(within) => setSpec((s) => ({ ...s, within }))}
                    options={[{ value: 'view', label: 'In this view' }, { value: 'dataSource', label: 'Whole data source' }]}
                  />
                </div>
              )}
            </Section>

            {/* How far */}
            <Section title="How far it reaches">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2" role="radiogroup" aria-label="Reach">
                {PRESETS.map((p) => {
                  const Icon = LucideIcons[PRESET_ICONS[p.id]] as LucideIcons.LucideIcon
                  const blocked = p.lineage && !lineageEnabled
                  const on = preset === p.id
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      disabled={blocked}
                      title={blocked ? 'Lineage trace is turned off for this deployment' : p.hint}
                      onClick={() => setExpand(p.expand)}
                      className={cn(
                        'group flex flex-col items-start gap-1.5 rounded-xl border px-3.5 py-3 text-left transition-colors',
                        on
                          ? 'border-accent-lineage/60 bg-accent-lineage/[0.08] ring-1 ring-accent-lineage/30'
                          : 'border-glass-border/80 hover:border-accent-lineage/40 hover:bg-accent-lineage/[0.03]',
                        blocked && 'opacity-50 cursor-not-allowed hover:border-glass-border/80 hover:bg-transparent',
                      )}
                    >
                      <span className={cn('w-7 h-7 rounded-lg grid place-items-center', on ? 'bg-accent-lineage/15 text-accent-lineage' : 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted group-hover:text-accent-lineage')}>
                        <Icon className="w-4 h-4" />
                      </span>
                      <span className="text-[13px] font-semibold text-ink leading-tight">{p.label}</span>
                      <span className="text-[11.5px] text-ink-muted leading-snug">{p.hint}</span>
                    </button>
                  )
                })}
              </div>

              <div className="mt-3 rounded-xl border border-glass-border/70 divide-y divide-glass-border/60">
                <ReachRow
                  icon={<LucideIcons.ListTree className="w-4 h-4" />}
                  title="Inside them"
                  added={result?.counts.inside}
                  loading={loading}
                  control={<LevelPicker label="Levels inside them" value={spec.expand.children} levels={[0, 1, 2]} onChange={(children) => setExpand({ children })} />}
                />
                <ReachRow
                  icon={<LucideIcons.ArrowUpLeft className="w-4 h-4" />}
                  title="Sources"
                  hint={lineageEnabled ? 'What feeds them' : 'Lineage trace is turned off'}
                  added={result?.counts.upstream}
                  loading={loading}
                  control={<HopPicker label="Steps upstream" value={spec.expand.upstream} disabled={!lineageEnabled} onChange={(upstream) => setExpand({ upstream })} />}
                />
                <ReachRow
                  icon={<LucideIcons.ArrowDownRight className="w-4 h-4" />}
                  title="Consumers"
                  hint={lineageEnabled ? 'What they feed' : 'Lineage trace is turned off'}
                  added={result?.counts.downstream}
                  loading={loading}
                  control={<HopPicker label="Steps downstream" value={spec.expand.downstream} disabled={!lineageEnabled} onChange={(downstream) => setExpand({ downstream })} />}
                />
                <ReachRow
                  icon={<LucideIcons.FolderOpen className="w-4 h-4" />}
                  title="Inside those"
                  hint="What sits inside the sources and consumers"
                  added={result?.counts.partnerInside}
                  loading={loading}
                  control={(
                    <LevelPicker
                      label="Levels inside the sources and consumers"
                      value={spec.expand.partnerChildren}
                      levels={[0, 1]}
                      disabled={spec.expand.upstream === 0 && spec.expand.downstream === 0}
                      onChange={(partnerChildren) => setExpand({ partnerChildren })}
                    />
                  )}
                />
              </div>
            </Section>

            {/* Preview */}
            <Section title="Preview">
              {lineageBlocked ? (
                <p className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 text-[13px] text-amber-700 dark:text-amber-400">
                  Sources and consumers need Lineage trace, which is turned off for this deployment. Choose a reach without them.
                </p>
              ) : (
              <Preview
                state={state}
                result={result}
                loading={loading}
                layers={layers}
                layerOf={layerOf}
                onRetry={retry}
              />
              )}
            </Section>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-4 px-7 py-4 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02]">
            <p className="min-w-0 text-[12.5px] text-ink-muted leading-snug">
              Shows <span className="text-ink font-medium">{sentence}</span>.
            </p>
            <div className="flex items-center gap-2 flex-none">
              <button type="button" onClick={onClose} className="h-9 px-4 rounded-xl text-[13px] font-semibold text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                Cancel
              </button>
              {onSaveAsView && (
                <button
                  type="button"
                  onClick={() => { if (ready) onSaveAsView({ ...draft, spec, seedsLabel: label }) }}
                  disabled={!ready}
                  title="Keep this as a view of its own, on the same data"
                  className="h-9 px-3.5 rounded-xl inline-flex items-center gap-1.5 text-[13px] font-semibold text-ink-secondary border border-glass-border hover:text-ink hover:border-accent-lineage/40 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                >
                  <LucideIcons.BookmarkPlus className="w-4 h-4 text-accent-lineage" />
                  Save as view…
                </button>
              )}
              <button
                type="button"
                onClick={apply}
                disabled={!ready}
                className={cn(
                  'h-9 px-4 rounded-xl inline-flex items-center gap-2 text-[13px] font-semibold transition',
                  ready ? 'bg-accent-lineage text-white shadow-sm hover:brightness-110' : 'bg-black/[0.06] dark:bg-white/[0.06] text-ink-muted cursor-not-allowed',
                )}
              >
                {loading ? <LucideIcons.Loader2 className="w-4 h-4 animate-spin" /> : <LucideIcons.ScanSearch className="w-4 h-4" />}
                Narrow
                {ready && <Kbd shortcut="mod+enter" tone="onAccent" />}
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </>,
    document.body,
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted/70 mb-2">{title}</p>
      {children}
    </section>
  )
}

/** One part of the reach: what it is, what it adds, and how far. */
function ReachRow({ icon, title, hint, added, loading, control }: {
  icon: ReactNode
  title: string
  hint?: string
  /** What this part adds; null: everything inside — in scope, not counted. */
  added: number | null | undefined
  loading: boolean
  control: ReactNode
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span className="w-7 h-7 rounded-lg grid place-items-center flex-none bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] font-semibold text-ink leading-tight">{title}</span>
        {hint && <span className="block text-[11.5px] text-ink-muted leading-snug">{hint}</span>}
      </span>
      <span className={cn('w-16 text-right text-[12px] font-semibold tabular-nums text-ink-muted', loading && 'animate-pulse opacity-60')}>
        {added === null ? 'all' : added ? `+${added.toLocaleString()}` : ''}
      </span>
      {control}
    </div>
  )
}

/** Levels inside: a few fixed steps, or everything. */
function LevelPicker({ label, value, levels, disabled, onChange }: {
  label: string
  value: Depth
  levels: number[]
  disabled?: boolean
  onChange: (value: Depth) => void
}) {
  const options = [...levels.map((l) => ({ value: String(l), label: l === 0 ? 'None' : String(l), disabled })),
    { value: 'all', label: 'All', disabled }]
  return (
    <Segmented
      label={label}
      value={String(value)}
      onChange={(v) => onChange(v === 'all' ? 'all' : Number(v))}
      options={options}
    />
  )
}

/** Lineage steps: a number up to the limit, or the whole way. */
function HopPicker({ label, value, disabled, onChange }: {
  label: string
  value: Depth
  disabled?: boolean
  onChange: (value: Depth) => void
}) {
  const all = value === 'all'
  const hops = all ? HOPS_MAX : value
  const step = (by: number) => onChange(Math.max(0, Math.min(HOPS_MAX, hops + by)))
  return (
    <div role="group" aria-label={label} className={cn('inline-flex items-center gap-1', disabled && 'opacity-50 pointer-events-none')}>
      <div className="inline-flex items-center rounded-lg bg-black/[0.05] dark:bg-white/[0.05] p-0.5">
        <button type="button" aria-label={`Fewer ${label.toLowerCase()}`} disabled={disabled || all || hops === 0} onClick={() => step(-1)}
          className="w-6 h-6 grid place-items-center rounded-md text-ink-muted hover:text-ink hover:bg-white/70 dark:hover:bg-white/10 disabled:opacity-30">
          <LucideIcons.Minus className="w-3 h-3" />
        </button>
        <span className="w-7 text-center text-[12px] font-semibold tabular-nums text-ink" aria-live="polite">{all ? '∞' : hops}</span>
        <button type="button" aria-label={`More ${label.toLowerCase()}`} disabled={disabled || all || hops === HOPS_MAX} onClick={() => step(1)}
          className="w-6 h-6 grid place-items-center rounded-md text-ink-muted hover:text-ink hover:bg-white/70 dark:hover:bg-white/10 disabled:opacity-30">
          <LucideIcons.Plus className="w-3 h-3" />
        </button>
      </div>
      <button
        type="button"
        aria-pressed={all}
        disabled={disabled}
        onClick={() => onChange(all ? 1 : 'all')}
        className={cn(
          'h-7 px-2 rounded-lg text-[11.5px] font-medium transition-colors',
          all ? 'bg-accent-lineage/15 text-accent-lineage border border-accent-lineage/35' : 'text-ink-muted border border-glass-border hover:text-ink',
        )}
      >
        All the way
      </button>
    </div>
  )
}

/** The answer: how many, where they sit, and every limit it reached. */
function Preview({ state, result, loading, layers, layerOf, onRetry }: {
  state: ReturnType<typeof useNarrowResolve>['state']
  result: MembershipResult | null
  loading: boolean
  layers: readonly NarrowLayer[]
  layerOf: (urn: string) => string | undefined
  onRetry: () => void
}) {
  const spread = useMemo(() => (result ? layerDistribution(result, layerOf) : null), [result, layerOf])
  if (state.status === 'error') {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/[0.06] px-4 py-3 text-[13px] text-red-600 dark:text-red-400">
        <span>{state.message}</span>
        <button type="button" onClick={onRetry} className="flex-none font-semibold underline-offset-2 hover:underline">Try again</button>
      </div>
    )
  }
  if (!result || !spread) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-glass-border/70 px-4 py-3 text-[13px] text-ink-muted">
        <LucideIcons.Loader2 className="w-3.5 h-3.5 animate-spin" />
        Working out what that reaches…
      </div>
    )
  }
  const byId = new Map(layers.map((l) => [l.id, l]))
  const total = result.members.length || 1
  const notes = truncationNotes(result)
  return (
    <div className={cn('rounded-xl border border-glass-border/70 px-4 py-3.5 space-y-3', loading && 'opacity-60 transition-opacity')}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-ink">
          <span className="text-lg font-semibold text-accent-lineage tabular-nums mr-1.5">{result.counts.total.toLocaleString()}</span>
          {result.counts.total === 1 ? 'entity' : 'entities'}
          {spread.layers.length > 0 && <span className="text-ink-muted"> across {n(spread.layers.length, 'layer')}</span>}
        </span>
        {result.wholeSubtree.length > 0 && (
          <span className="text-[11.5px] text-ink-muted">plus everything inside {n(result.wholeSubtree.length, 'of them', 'of them')}</span>
        )}
      </div>

      {/* Where they sit: one segment per layer, in the layer's colour. */}
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-black/[0.05] dark:bg-white/[0.06]" aria-hidden="true">
        {spread.layers.map((s) => (
          <span key={s.layerId} className="h-full" style={{ flexGrow: s.count / total, backgroundColor: byId.get(s.layerId)?.color ?? '#94a3b8' }} />
        ))}
        {spread.elsewhere > 0 && (
          <span className="h-full bg-[repeating-linear-gradient(45deg,transparent_0_3px,rgba(148,163,184,0.45)_3px_6px)]" style={{ flexGrow: spread.elsewhere / total }} />
        )}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-ink-muted" aria-label="Where they sit">
        {spread.layers.map((s) => (
          <li key={s.layerId} className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: byId.get(s.layerId)?.color ?? '#94a3b8' }} />
            {byId.get(s.layerId)?.name ?? 'Layer'} <span className="tabular-nums text-ink">{s.count.toLocaleString()}</span>
          </li>
        ))}
        {spread.elsewhere > 0 && (
          <li className="inline-flex items-center gap-1.5" title="Not loaded on the canvas yet, or outside this view’s layers">
            <span className="w-2 h-2 rounded-full border border-dashed border-ink-muted/60" />
            Not on the canvas yet <span className="tabular-nums text-ink">{spread.elsewhere.toLocaleString()}</span>
          </li>
        )}
      </ul>

      <AnimatePresence initial={false}>
        {(notes.length > 0 || result.missingSeeds > 0) && (
          <motion.ul
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={MOTION.fadeIn}
            className="space-y-1 text-[12px] text-amber-700 dark:text-amber-400"
          >
            {result.missingSeeds > 0 && (
              <li>{n(result.missingSeeds, 'chosen entity no longer exists', 'chosen entities no longer exist')} — left out.</li>
            )}
            {notes.map((note) => <li key={note}>{note}</li>)}
            {canRetry(result) && (
              <li><button type="button" onClick={onRetry} className="font-semibold underline-offset-2 hover:underline">Try again</button></li>
            )}
          </motion.ul>
        )}
      </AnimatePresence>
      {result.counts.total === 0 && (
        <p className="text-[12.5px] text-ink-muted">Nothing to show — none of the starting points exist any more.</p>
      )}
    </div>
  )
}
