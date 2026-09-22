/**
 * BulkLinkPanel — link the selection to other entities in one go, in a draft,
 * as three guided steps under a live picture of what will be made.
 *
 * The selection is one side. The reader chooses the other side (step 1) —
 * from the list, grouped by type with the entities that can take a link
 * first, or by clicking cards on the canvas — then the relationship (step 2),
 * then reviews every pair (step 3): the links that will be added and the ones
 * that won't, each with its reason. The flow diagram above (BulkLinkFlow)
 * says it all at a glance and carries the direction: Swap flips which side
 * feeds which, and sources always read on the left.
 *
 * Every pair is judged by the hand-drawn link's own gate (bulkLinks.ts),
 * through the one model the drop card also reads (useBulkLinkModel). More
 * than BULK_LINK_CONFIRM_ABOVE links asks first; more than BULK_LINK_MAX is
 * refused with how to narrow it. Adding stages one batch into the draft.
 */
import { useMemo, useState } from 'react'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { isSelectableNode, useCanvasStore } from '@/store/canvas'
import { BULK_LINK_MAX, candidateFit, type LinkPair, type PairVerdict } from '@/lib/bulkLinks'
import { BulkLinkFlow } from './BulkLinkFlow'
import { useBulkLinkStore } from './bulkLinkStore'
import { useBulkLinkModel, type BulkLinkModel } from './useBulkLinkModel'

/** Rows a type group lists before "Show more". */
const GROUP_PAGE = 30

export interface BulkLinkPanelProps {
  /** The canvas selection — one side of every link. */
  selection: readonly string[]
  labelFor: (id: string) => string
  /** Stage the links. Returns how many were staged and the pairs refused. */
  onCreate: (pairs: LinkPair[], edgeType: string) => { staged: number; rejected: PairVerdict[] }
  onClose: () => void
}

export function BulkLinkPanel({ selection, labelFor, onCreate, onClose }: BulkLinkPanelProps) {
  const model = useBulkLinkModel(selection)
  const swap = useBulkLinkStore((s) => s.swap)
  const [confirming, setConfirming] = useState(false)

  const selected = useMemo(() => new Set(selection), [selection])
  const verdictByPair = useMemo(() => new Map(model.verdicts.map((v) => [`${v.source}\u0000${v.target}`, v])), [model.verdicts])
  const verdictOf = (s: string, t: string): 'ok' | 'skip' | undefined => {
    const v = verdictByPair.get(`${s}\u0000${t}`)
    return v ? (v.ok ? 'ok' : 'skip') : undefined
  }

  const otherSide = model.direction === 'selection-feeds' ? 'targets' : 'sources'
  const step1Done = model.picked.length > 0
  const step2Done = step1Done && model.edgeType !== null
  const count = model.toCreate.length

  const create = () => {
    if (!model.edgeType || count === 0 || model.overMax) return
    if (model.needsConfirm && !confirming) {
      setConfirming(true)
      return
    }
    onCreate(model.toCreate.map(({ source, target }) => ({ source, target })), model.edgeType)
    onClose()
  }

  return (
    <div
      role="dialog"
      aria-label={`Link ${selection.length} selected entities`}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
      className="absolute z-[60] left-4 flex justify-center pointer-events-none"
      style={{
        right: 'calc(20rem + 1.75rem)',
        bottom: 'calc(0.75rem + var(--trace-dock-height, 0px) + var(--layer-strip-height, 0px))',
        maxHeight: 'calc(100% - 5rem)',
      }}
    >
      <div className="pointer-events-auto w-[600px] max-w-full max-h-full flex flex-col rounded-2xl bg-canvas-elevated border border-glass-border shadow-2xl shadow-black/15 dark:shadow-black/50 overflow-hidden">
        {/* Header */}
        <div className="flex items-start gap-3 px-5 pt-4 pb-3">
          <span className="mt-0.5 w-9 h-9 shrink-0 rounded-xl bg-accent-lineage/15 grid place-items-center">
            <LucideIcons.Link2 className="w-[18px] h-[18px] text-accent-lineage" strokeWidth={2.2} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold text-ink leading-tight">Link {selection.length} selected entities</h2>
            <p className="mt-0.5 text-[12px] text-ink-muted">
              Every link is checked against the ontology before it joins your draft.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 transition-colors"
          >
            <LucideIcons.X className="w-4 h-4" />
          </button>
        </div>

        {/* What will be made */}
        <div className="px-5 pb-3">
          <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] px-3 py-3">
            <BulkLinkFlow
              sources={model.sources}
              targets={model.targets}
              selection={selected}
              labelFor={labelFor}
              lookOf={model.lookOf}
              verdictOf={verdictOf}
              relationship={model.relationship}
              onSwap={() => { setConfirming(false); swap() }}
            />
            <p className="mt-2.5 text-[11.5px] text-ink-muted" aria-live="polite">
              {model.direction === 'selection-feeds'
                ? `Data flows from the ${selection.length} selected into the ${otherSide} you choose.`
                : `Data flows from the ${otherSide} you choose into the ${selection.length} selected.`}
            </p>
          </div>
        </div>

        <div className="min-h-0 overflow-y-auto custom-scrollbar px-5 pb-4 space-y-2">
          <Step
            n={1}
            done={step1Done}
            title={`Choose the ${otherSide}`}
            summary={step1Done ? `${model.picked.length.toLocaleString()} chosen` : undefined}
          >
            <OtherSidePicker model={model} selection={selection} selected={selected} labelFor={labelFor} otherSide={otherSide} onChange={() => setConfirming(false)} />
          </Step>

          <Step
            n={2}
            done={step2Done}
            disabled={!step1Done}
            title="Choose the relationship"
            summary={model.relationship ?? undefined}
            hint={!step1Done ? `Choose at least one of the ${otherSide} first.` : undefined}
          >
            <RelationshipChoice model={model} onChange={() => setConfirming(false)} />
          </Step>

          <Step
            n={3}
            done={false}
            disabled={!step2Done}
            title="Review"
            summary={step2Done ? reviewSummary(count, model.skipped) : undefined}
            hint={!step2Done ? 'Each pair shows here with what will happen to it.' : undefined}
          >
            <Review model={model} labelFor={labelFor} />
          </Step>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-5 py-3 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02]">
          <p className="min-w-0 flex-1 text-[12px] text-ink-muted" aria-live="polite">
            {model.overMax
              ? `That's ${count.toLocaleString()} links — a batch holds at most ${BULK_LINK_MAX.toLocaleString()}. Narrow either side.`
              : confirming
                ? `Add ${count.toLocaleString()} links to your draft?`
                : count > 0
                  ? 'They join your draft; save it when you are ready.'
                  : ''}
          </p>
          <button
            type="button"
            onClick={confirming ? () => setConfirming(false) : onClose}
            className="px-3 py-1.5 rounded-lg text-[12.5px] text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          >
            {confirming ? 'Back' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={create}
            disabled={!model.edgeType || count === 0 || model.overMax}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[12.5px] font-semibold bg-accent-lineage text-white shadow-sm hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/50 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <LucideIcons.Link2 className="w-3.5 h-3.5" />
            {confirming ? 'Yes, add them' : `Add ${count.toLocaleString()} ${count === 1 ? 'link' : 'links'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

function reviewSummary(count: number, skipped: number): string {
  const added = `${count.toLocaleString()} ${count === 1 ? 'link' : 'links'} will be added`
  return skipped > 0 ? `${added} · ${skipped.toLocaleString()} skipped` : added
}

/** One step of three: its number (a tick when done), its title, what it holds. */
function Step({
  n, done, disabled = false, title, summary, hint, children,
}: {
  n: number
  done: boolean
  disabled?: boolean
  title: string
  summary?: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section aria-label={title} className={cn('rounded-xl border px-3.5 py-3', disabled ? 'border-glass-border opacity-60' : 'border-glass-border')}>
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            'w-5 h-5 shrink-0 rounded-full grid place-items-center text-[10.5px] font-semibold',
            done ? 'bg-lineage-out text-white' : disabled ? 'border border-glass-border text-ink-muted' : 'bg-accent-lineage text-white',
          )}
          aria-hidden
        >
          {done ? <LucideIcons.Check className="w-3 h-3" strokeWidth={3} /> : n}
        </span>
        <h3 className="text-[12.5px] font-semibold text-ink">{title}</h3>
        {summary && <span className="ml-auto min-w-0 truncate text-[11.5px] text-ink-muted">{summary}</span>}
      </div>
      {disabled ? (
        hint && <p className="mt-1.5 pl-[30px] text-[11.5px] text-ink-muted">{hint}</p>
      ) : (
        <div className="mt-2.5">{children}</div>
      )}
    </section>
  )
}

function OtherSidePicker({
  model, selection, selected, labelFor, otherSide, onChange,
}: {
  model: BulkLinkModel
  selection: readonly string[]
  selected: ReadonlySet<string>
  labelFor: (id: string) => string
  otherSide: 'targets' | 'sources'
  onChange: () => void
}) {
  const nodes = useCanvasStore((s) => s.nodes)
  const togglePicked = useBulkLinkStore((s) => s.togglePicked)
  const pickingOnCanvas = useBulkLinkStore((s) => s.pickingOnCanvas)
  const setPickingOnCanvas = useBulkLinkStore((s) => s.setPickingOnCanvas)
  const [query, setQuery] = useState('')
  const [shownOf, setShownOf] = useState<Record<string, number>>({})

  const q = query.trim().toLowerCase()
  const groups = useMemo(() => {
    const byType = new Map<string, Array<{ id: string; name: string; fits: number; reason?: string }>>()
    for (const n of nodes) {
      if (selected.has(n.id) || !isSelectableNode(n.id)) continue
      const name = labelFor(n.id)
      const look = model.lookOf(n.id)
      if (q && !name.toLowerCase().includes(q) && !look.typeName.toLowerCase().includes(q)) continue
      const fit = candidateFit(n.id, selection, model.direction, model.fit)
      const list = byType.get(look.typeName)
      const row = { id: n.id, name, ...fit }
      if (list) list.push(row)
      else byType.set(look.typeName, [row])
    }
    const out = [...byType.entries()].map(([typeName, rows]) => {
      rows.sort((a, b) => b.fits - a.fits || a.name.localeCompare(b.name))
      return { typeName, rows, linkable: rows.filter((r) => r.fits > 0).length }
    })
    // Types that can take a link first.
    return out.sort((a, b) => b.linkable - a.linkable || a.typeName.localeCompare(b.typeName))
  }, [nodes, selected, labelFor, model, q, selection])

  const pick = (id: string) => { onChange(); togglePicked(id) }

  return (
    <div>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <LucideIcons.Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted pointer-events-none" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${otherSide} by name or type…`}
            aria-label="Search entities to link"
            className="w-full pl-8 pr-3 py-1.5 text-[12px] rounded-lg bg-black/[0.04] dark:bg-white/[0.04] border border-glass-border focus:border-accent-lineage/40 outline-none transition-colors placeholder:text-ink-muted"
          />
        </div>
        <button
          type="button"
          onClick={() => setPickingOnCanvas(!pickingOnCanvas)}
          aria-pressed={pickingOnCanvas}
          className={cn(
            'shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[12px] font-medium transition-colors',
            pickingOnCanvas
              ? 'border-accent-lineage bg-accent-lineage/10 text-accent-lineage'
              : 'border-glass-border text-ink-muted hover:text-ink',
          )}
        >
          <LucideIcons.MousePointerClick className="w-3.5 h-3.5" />
          {pickingOnCanvas ? 'Picking on canvas' : 'Pick on canvas'}
        </button>
      </div>
      {pickingOnCanvas && (
        <p className="mt-1.5 text-[11.5px] text-accent-lineage">
          Click cards on the canvas to add them — click again to take one off.
        </p>
      )}

      <div className="mt-2 max-h-60 overflow-y-auto custom-scrollbar space-y-2 pr-0.5">
        {groups.length === 0 && (
          <p className="px-1 py-2 text-[12px] text-ink-muted">
            {q ? 'Nothing on the canvas matches.' : 'No other entities are loaded on the canvas.'}
          </p>
        )}
        {groups.map((g) => {
          const limit = shownOf[g.typeName] ?? GROUP_PAGE
          const look = g.rows[0] ? model.lookOf(g.rows[0].id) : null
          return (
            <div key={g.typeName}>
              <div className="flex items-center gap-1.5 px-1 pb-1">
                {look && (
                  <span className="w-4 h-4 rounded grid place-items-center" style={{ backgroundColor: `${look.color}22`, color: look.color }}>
                    <DynamicIcon name={look.icon} className="w-2.5 h-2.5" />
                  </span>
                )}
                <span className="text-[11.5px] font-semibold text-ink">{g.typeName || 'Other'}</span>
                <span className="text-[11px] text-ink-muted">
                  {g.linkable > 0 ? `${g.linkable.toLocaleString()} can link` : 'none can link'}
                </span>
              </div>
              <ul className="rounded-lg border border-glass-border divide-y divide-glass-border overflow-hidden">
                {g.rows.slice(0, limit).map((r) => {
                  const on = model.picked.includes(r.id)
                  const blocked = r.fits === 0
                  return (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => pick(r.id)}
                        aria-pressed={on}
                        title={blocked ? r.reason : undefined}
                        className={cn(
                          'w-full flex items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors',
                          on ? 'bg-accent-lineage/10' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
                          blocked && !on && 'opacity-55',
                        )}
                      >
                        <span
                          className={cn(
                            'w-4 h-4 shrink-0 rounded-full grid place-items-center border transition-colors',
                            on ? 'bg-accent-lineage border-accent-lineage text-white' : 'border-glass-border',
                          )}
                          aria-hidden
                        >
                          {on && <LucideIcons.Check className="w-2.5 h-2.5" strokeWidth={3} />}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{r.name}</span>
                        <FitPill fits={r.fits} of={selection.length} />
                      </button>
                    </li>
                  )
                })}
              </ul>
              {g.rows.length > limit && (
                <button
                  type="button"
                  onClick={() => setShownOf((m) => ({ ...m, [g.typeName]: limit + GROUP_PAGE }))}
                  className="mt-1 px-1 text-[11.5px] font-medium text-accent-lineage hover:underline"
                >
                  Show {Math.min(GROUP_PAGE, g.rows.length - limit).toLocaleString()} more of {(g.rows.length - limit).toLocaleString()}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** How much of the selection a candidate can be linked with. */
function FitPill({ fits, of }: { fits: number; of: number }) {
  if (fits === 0) return <span className="shrink-0 text-[10.5px] text-ink-muted">Can't link</span>
  const all = fits >= of
  return (
    <span
      className={cn(
        'shrink-0 px-1.5 py-0.5 rounded-full text-[10.5px] font-medium tabular-nums',
        all ? 'bg-lineage-out/15 text-lineage-out' : 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
      )}
    >
      {all ? 'Can link' : `${fits} of ${of}`}
    </span>
  )
}

function RelationshipChoice({ model, onChange }: { model: BulkLinkModel; onChange: () => void }) {
  const setChosenType = useBulkLinkStore((s) => s.setChosenType)
  if (model.options.length === 0) {
    return (
      <div className="flex items-start gap-2 p-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 text-[12px]">
        <LucideIcons.AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-500" />
        <span className="text-ink">
          No lineage relationship in the ontology can join these.
          {model.noFitReason && <span className="block mt-0.5 text-ink-muted">{model.noFitReason}</span>}
        </span>
      </div>
    )
  }
  const total = model.pairs.length
  return (
    <div role="radiogroup" aria-label="Relationship" className="space-y-1.5">
      {model.options.map((o) => {
        const on = o.edgeType === model.edgeType
        return (
          <button
            key={o.edgeType}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => { onChange(); setChosenType(o.edgeType) }}
            className={cn(
              'w-full flex items-center gap-3 px-3 py-2 rounded-lg border text-left transition-colors',
              on ? 'border-accent-lineage bg-accent-lineage/[0.06]' : 'border-glass-border hover:border-accent-lineage/35',
            )}
          >
            <span className={cn('w-3.5 h-3.5 shrink-0 rounded-full border-2 grid place-items-center', on ? 'border-accent-lineage' : 'border-glass-border')}>
              {on && <span className="w-1.5 h-1.5 rounded-full bg-accent-lineage" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12.5px] font-medium text-ink">{o.label}</span>
              {o.description && <span className="block truncate text-[11px] text-ink-muted">{o.description}</span>}
            </span>
            <span className="shrink-0 w-24">
              <span className="block text-right text-[11px] tabular-nums text-ink-muted">fits {o.fits.toLocaleString()} of {total.toLocaleString()}</span>
              <span className="mt-1 block h-1 rounded-full bg-black/[0.06] dark:bg-white/[0.08] overflow-hidden">
                <span className="block h-full rounded-full bg-lineage-out" style={{ width: `${Math.max(4, (o.fits / Math.max(1, total)) * 100)}%` }} />
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** Every pair, grouped by target, with what will happen to it. */
function Review({ model, labelFor }: { model: BulkLinkModel; labelFor: (id: string) => string }) {
  const byTarget = useMemo(() => {
    const m = new Map<string, PairVerdict[]>()
    for (const v of model.verdicts) {
      const list = m.get(v.target)
      if (list) list.push(v)
      else m.set(v.target, [v])
    }
    return [...m.entries()]
  }, [model.verdicts])

  return (
    <div className="max-h-56 overflow-y-auto custom-scrollbar space-y-2 pr-0.5" aria-label="Preview">
      <div className="flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-lineage-out/15 text-lineage-out text-[11px] font-medium">
          <LucideIcons.Check className="w-3 h-3" strokeWidth={2.6} />
          {model.toCreate.length.toLocaleString()} will be added
        </span>
        {model.skipped > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[11px] font-medium">
            <LucideIcons.MinusCircle className="w-3 h-3" />
            {model.skipped.toLocaleString()} skipped
          </span>
        )}
      </div>
      {byTarget.map(([target, pairs]) => (
        <div key={target} className="rounded-lg border border-glass-border overflow-hidden">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-black/[0.02] dark:bg-white/[0.03]">
            <LucideIcons.ArrowDownToLine className="w-3.5 h-3.5 text-ink-muted" aria-hidden />
            <span className="truncate text-[12px] font-semibold text-ink">{labelFor(target)}</span>
            <span className="text-[11px] text-ink-muted">receives</span>
          </div>
          <ul className="divide-y divide-glass-border">
            {pairs.map((v) => (
              <li key={`${v.source}\u0000${v.target}`} className="flex items-start gap-2 px-2.5 py-1.5">
                {v.ok
                  ? <LucideIcons.Check className="w-3.5 h-3.5 mt-0.5 shrink-0 text-lineage-out" strokeWidth={2.6} aria-label="Will be added" />
                  : <LucideIcons.MinusCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-500" aria-label="Skipped" />}
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-[12px]', v.ok ? 'text-ink' : 'text-ink-muted')}>from {labelFor(v.source)}</span>
                  {!v.ok && v.reason && <span className="block text-[11px] text-ink-muted leading-snug">{v.reason}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
