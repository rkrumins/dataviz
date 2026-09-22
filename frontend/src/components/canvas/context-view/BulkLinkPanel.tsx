/**
 * BulkLinkPanel — link the selection to other entities in one go, in a draft.
 *
 * The selection is one side. The reader says which way the data flows — the
 * selection feeds the entities they pick, or those entities feed the
 * selection — then picks the other side, one entity or many. So N → 1,
 * 1 → N and N × M are the same three steps, and the direction is always
 * written out, never guessed from click order. Sources read on the left,
 * targets on the right, whichever side the selection is on.
 *
 * One relationship for the batch, from the lineage relationships the
 * ontology allows (each shown with how many pairs it fits). Every pair is
 * judged by the hand-drawn link's own gate (bulkLinks.ts), and the preview
 * lists every one: the links that will be added, and the ones that won't,
 * each with its reason. Large batches ask first; enormous ones are refused
 * (BULK_LINK_CONFIRM_ABOVE / BULK_LINK_MAX). Creating stages one batch into
 * the draft — reviewed and saved like any other change.
 */
import { useMemo, useState } from 'react'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { isSelectableNode, useCanvasStore } from '@/store/canvas'
import { useViewContainmentEdgeTypes, useViewEntityTypes, useViewRelationshipTypes } from '@/hooks/useViewSchema'
import { relationshipLabel } from '@/lib/relationshipLabel'
import {
  BULK_LINK_CONFIRM_ABOVE,
  BULK_LINK_MAX,
  batchTypeOptions,
  expandPairs,
  judgePairs,
  type BulkDirection,
  type BulkLinkContext,
  type LinkPair,
  type PairVerdict,
} from '@/lib/bulkLinks'

/** Candidate rows listed before the search has to narrow them. */
const CANDIDATE_LIMIT = 100

export interface BulkLinkPanelProps {
  /** The canvas selection — one side of every link. */
  selection: readonly string[]
  labelFor: (id: string) => string
  /** Stage the links. Returns how many were staged and the pairs refused. */
  onCreate: (pairs: LinkPair[], edgeType: string) => { staged: number; rejected: PairVerdict[] }
  onClose: () => void
}

export function BulkLinkPanel({ selection, labelFor, onCreate, onClose }: BulkLinkPanelProps) {
  const nodes = useCanvasStore((s) => s.nodes)
  const edges = useCanvasStore((s) => s.edges)
  const entityTypes = useViewEntityTypes()
  const relationshipTypes = useViewRelationshipTypes()
  const containmentEdgeTypes = useViewContainmentEdgeTypes()

  const [direction, setDirection] = useState<BulkDirection>('selection-feeds')
  const [picked, setPicked] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [chosenType, setChosenType] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const typeNameById = useMemo(() => new Map(entityTypes.map((t) => [t.id, t.name])), [entityTypes])
  const typeOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of nodes) {
      const type = n.data?.type as string | undefined
      if (!type) continue
      m.set(n.id, type)
      const urn = n.data?.urn as string | undefined
      if (urn) m.set(urn, type)
    }
    return m
  }, [nodes])

  const ctx: BulkLinkContext = useMemo(() => ({
    typeOf: (urn) => typeOf.get(urn) ?? null,
    relationshipTypes,
    containmentEdgeTypes,
    entityTypes,
    existingEdges: edges,
  }), [typeOf, relationshipTypes, containmentEdgeTypes, entityTypes, edges])

  // The other side: any entity on the canvas that is not in the selection.
  const selected = useMemo(() => new Set(selection), [selection])
  const q = query.trim().toLowerCase()
  const candidates = useMemo(() => {
    const out: Array<{ id: string; name: string; typeName: string }> = []
    let more = 0
    for (const n of nodes) {
      if (selected.has(n.id) || !isSelectableNode(n.id)) continue
      const name = labelFor(n.id)
      const typeName = typeNameById.get(n.data?.type as string) ?? (n.data?.type as string) ?? ''
      if (q && !name.toLowerCase().includes(q) && !typeName.toLowerCase().includes(q)) continue
      if (out.length < CANDIDATE_LIMIT) out.push({ id: n.id, name, typeName })
      else more++
    }
    return { rows: out, more }
  }, [nodes, selected, labelFor, typeNameById, q])

  const pairs = useMemo(() => expandPairs(selection, picked, direction), [selection, picked, direction])
  const options = useMemo(() => batchTypeOptions(pairs, ctx), [pairs, ctx])
  const edgeType = options.some((o) => o.edgeType === chosenType) ? chosenType : (options[0]?.edgeType ?? null)
  const verdicts = useMemo(() => (edgeType ? judgePairs(pairs, edgeType, ctx) : []), [pairs, edgeType, ctx])
  const toCreate = verdicts.filter((v) => v.ok)
  const skipped = verdicts.length - toCreate.length
  const overMax = toCreate.length > BULK_LINK_MAX
  const needsConfirm = toCreate.length > BULK_LINK_CONFIRM_ABOVE

  // Why nothing fits, in the ontology's words: the first pair's reasons.
  const noFitReason = useMemo(() => {
    if (pairs.length === 0 || options.length > 0) return null
    const drawable = relationshipTypes.find((r) => (r.isLineage ?? true) && !r.isContainment)
    return drawable ? judgePairs([pairs[0]], drawable.id, ctx)[0].reason ?? null : null
  }, [pairs, options, relationshipTypes, ctx])

  const togglePicked = (id: string) => {
    setConfirming(false)
    setPicked((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]))
  }

  const create = () => {
    if (!edgeType || toCreate.length === 0 || overMax) return
    if (needsConfirm && !confirming) {
      setConfirming(true)
      return
    }
    onCreate(toCreate.map(({ source, target }) => ({ source, target })), edgeType)
    onClose()
  }

  const selectionSide = (
    <SideCard
      title={`${selection.length} selected`}
      names={selection.map(labelFor)}
      tone="selection"
    />
  )
  const otherSide = (
    <SideCard
      title={picked.length > 0 ? `${picked.length} picked` : 'Pick below'}
      names={picked.map(labelFor)}
      tone="picked"
    />
  )
  const sources = direction === 'selection-feeds' ? selectionSide : otherSide
  const targets = direction === 'selection-feeds' ? otherSide : selectionSide

  return (
    <div
      role="dialog"
      aria-label={`Link ${selection.length} selected entities`}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
      className="absolute z-[60] left-4 flex justify-center pointer-events-none"
      style={{
        right: 'calc(20rem + 1.75rem)',
        bottom: 'calc(1.25rem + var(--trace-dock-height, 0px) + var(--layer-strip-height, 0px) + var(--selection-bar-height, 0px))',
        maxHeight: 'calc(100% - 7rem)',
      }}
    >
      <div className="pointer-events-auto w-[560px] max-w-full max-h-full flex flex-col rounded-2xl bg-canvas-elevated border border-glass-border shadow-2xl shadow-black/15 dark:shadow-black/50 overflow-hidden">
        {/* Header */}
        <div className="flex items-start gap-3 px-4 pt-3.5 pb-3 border-b border-glass-border">
          <span className="mt-0.5 w-8 h-8 shrink-0 rounded-xl bg-accent-lineage/15 flex items-center justify-center">
            <LucideIcons.Link2 className="w-4 h-4 text-accent-lineage" strokeWidth={2.2} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[13.5px] font-semibold text-ink leading-tight">Link {selection.length} selected entities</h2>
            <p className="mt-0.5 text-[11.5px] text-ink-muted">
              Each link is checked against the ontology, then added to your draft.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          >
            <LucideIcons.X className="w-4 h-4" />
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto custom-scrollbar px-4 py-3 space-y-4">
          {/* Direction: sources always on the left. */}
          <section aria-label="Direction">
            <SectionTitle>Direction</SectionTitle>
            <div className="flex items-stretch gap-2">
              {sources}
              <div className="flex flex-col items-center justify-center gap-1 shrink-0 px-1">
                <span className="text-[10.5px] font-medium text-ink-muted">feed</span>
                <LucideIcons.ArrowRight className="w-5 h-5 text-accent-lineage" strokeWidth={2.2} />
                <button
                  type="button"
                  onClick={() => { setConfirming(false); setDirection((d) => (d === 'selection-feeds' ? 'feeds-selection' : 'selection-feeds')) }}
                  aria-label="Swap direction"
                  title="Swap which side feeds which"
                  className="mt-0.5 flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-medium text-accent-lineage hover:bg-accent-lineage/10 transition-colors"
                >
                  <LucideIcons.ArrowLeftRight className="w-3 h-3" />
                  Swap
                </button>
              </div>
              {targets}
            </div>
            <p className="mt-1.5 text-[11px] text-ink-muted" aria-live="polite">
              {direction === 'selection-feeds'
                ? `The ${selection.length} selected are the sources; data flows from them to what you pick.`
                : `What you pick are the sources; data flows from them into the ${selection.length} selected.`}
            </p>
          </section>

          {/* The other side */}
          <section aria-label="Other side">
            <SectionTitle>{direction === 'selection-feeds' ? 'Targets' : 'Sources'}</SectionTitle>
            <div className="relative">
              <LucideIcons.Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted pointer-events-none" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search entities on the canvas…"
                aria-label="Search entities to link"
                className="w-full pl-8 pr-3 py-1.5 text-[12px] rounded-lg bg-black/[0.04] dark:bg-white/[0.04] border border-glass-border focus:border-accent-lineage/40 outline-none transition-colors placeholder:text-ink-muted"
              />
            </div>
            <ul className="mt-1.5 max-h-44 overflow-y-auto custom-scrollbar rounded-lg border border-glass-border divide-y divide-glass-border">
              {candidates.rows.length === 0 && (
                <li className="px-3 py-3 text-[11.5px] text-ink-muted">
                  {q ? 'Nothing on the canvas matches.' : 'No other entities on the canvas.'}
                </li>
              )}
              {candidates.rows.map((c) => {
                const on = picked.includes(c.id)
                return (
                  <li key={c.id}>
                    <label className={cn('flex items-center gap-2.5 px-3 py-1.5 cursor-pointer transition-colors', on ? 'bg-accent-lineage/10' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]')}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => togglePicked(c.id)}
                        className="accent-accent-lineage"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] text-ink">{c.name}</span>
                        {c.typeName && <span className="block truncate text-[10.5px] text-ink-muted">{c.typeName}</span>}
                      </span>
                    </label>
                  </li>
                )
              })}
              {candidates.more > 0 && (
                <li className="px-3 py-1.5 text-[11px] text-ink-muted">
                  {candidates.more.toLocaleString()} more — search to narrow the list.
                </li>
              )}
            </ul>
          </section>

          {/* Relationship */}
          <section aria-label="Relationship">
            <SectionTitle>Relationship</SectionTitle>
            {pairs.length === 0 ? (
              <p className="text-[11.5px] text-ink-muted">Pick at least one entity above.</p>
            ) : options.length === 0 ? (
              <div className="flex items-start gap-2 p-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 text-[11.5px]">
                <LucideIcons.AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-500" />
                <span className="text-ink">
                  No lineage relationship in the ontology can join these.
                  {noFitReason && <span className="block mt-0.5 text-ink-muted">{noFitReason}</span>}
                </span>
              </div>
            ) : (
              <div role="radiogroup" aria-label="Relationship" className="flex flex-wrap gap-1.5">
                {options.map((o) => {
                  const on = o.edgeType === edgeType
                  return (
                    <button
                      key={o.edgeType}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => { setConfirming(false); setChosenType(o.edgeType) }}
                      title={o.description}
                      className={cn(
                        'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[12px] transition-colors',
                        on ? 'border-accent-lineage bg-accent-lineage/10 text-ink' : 'border-glass-border text-ink-muted hover:text-ink',
                      )}
                    >
                      <span className={cn('w-3 h-3 rounded-full border-2 grid place-items-center', on ? 'border-accent-lineage' : 'border-glass-border')}>
                        {on && <span className="w-1.5 h-1.5 rounded-full bg-accent-lineage" />}
                      </span>
                      <span className="font-medium">{o.label && o.label !== o.edgeType ? o.label : relationshipLabel(o.edgeType)}</span>
                      <span className="tabular-nums text-ink-muted">fits {o.fits.toLocaleString()} of {pairs.length.toLocaleString()}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </section>

          {/* Preview: every pair, and what will happen to it. */}
          {verdicts.length > 0 && (
            <section aria-label="Preview">
              <SectionTitle>
                {toCreate.length.toLocaleString()} {toCreate.length === 1 ? 'link' : 'links'} will be added
                {skipped > 0 && ` · ${skipped.toLocaleString()} skipped`}
              </SectionTitle>
              <ul className="max-h-48 overflow-y-auto custom-scrollbar rounded-lg border border-glass-border divide-y divide-glass-border">
                {verdicts.map((v) => (
                  <li key={`${v.source}\u0000${v.target}`} className="flex items-start gap-2 px-3 py-1.5">
                    {v.ok
                      ? <LucideIcons.Check className="w-3.5 h-3.5 mt-0.5 shrink-0 text-lineage-out" strokeWidth={2.4} aria-label="Will be added" />
                      : <LucideIcons.MinusCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-500" aria-label="Skipped" />}
                    <span className="min-w-0 flex-1">
                      <span className={cn('flex items-center gap-1.5 text-[12px]', v.ok ? 'text-ink' : 'text-ink-muted')}>
                        <span className="truncate">{labelFor(v.source)}</span>
                        <LucideIcons.ArrowRight className="w-3 h-3 shrink-0 text-ink-muted" />
                        <span className="truncate">{labelFor(v.target)}</span>
                      </span>
                      {!v.ok && v.reason && <span className="block text-[10.5px] text-ink-muted leading-snug">{v.reason}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-glass-border">
          <p className="min-w-0 flex-1 text-[11.5px] text-ink-muted" aria-live="polite">
            {overMax
              ? `That's ${toCreate.length.toLocaleString()} links — a batch holds at most ${BULK_LINK_MAX.toLocaleString()}. Narrow either side.`
              : confirming
                ? `Add ${toCreate.length.toLocaleString()} links to your draft?`
                : toCreate.length > 0
                  ? 'Added to your draft; save it when you are done.'
                  : ''}
          </p>
          <button
            type="button"
            onClick={confirming ? () => setConfirming(false) : onClose}
            className="px-3 py-1.5 rounded-lg text-[12px] text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          >
            {confirming ? 'Back' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={create}
            disabled={!edgeType || toCreate.length === 0 || overMax}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[12px] font-semibold bg-accent-lineage text-white shadow-sm hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <LucideIcons.Link2 className="w-3.5 h-3.5" />
            {confirming ? 'Yes, add them' : `Add ${toCreate.length.toLocaleString()} ${toCreate.length === 1 ? 'link' : 'links'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-1.5 text-[11.5px] font-semibold text-ink">{children}</h3>
}

/** One side of the links: who is on it, named. */
function SideCard({ title, names, tone }: { title: string; names: string[]; tone: 'selection' | 'picked' }) {
  const shown = names.slice(0, 3)
  const rest = names.length - shown.length
  return (
    <div
      className={cn(
        'flex-1 min-w-0 rounded-xl border px-3 py-2',
        tone === 'selection' ? 'border-accent-lineage/35 bg-accent-lineage/10' : 'border-glass-border',
      )}
    >
      <div className="text-[12px] font-semibold text-ink">{title}</div>
      <div className="mt-0.5 text-[11px] text-ink-muted truncate" title={names.join(', ')}>
        {shown.length > 0 ? `${shown.join(', ')}${rest > 0 ? ` +${rest}` : ''}` : 'Nothing yet'}
      </div>
    </div>
  )
}
