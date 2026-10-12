/**
 * BulkLinkCard — what a drag that carries a selection opens where it drops:
 * the links it would make, drawn small, the relationship, and one button that
 * adds them. Everything the full Link panel does is one click away
 * ("More options…" opens it exactly as this card holds it), so the card only
 * carries what a drop needs: see it, adjust the direction or the relationship,
 * add more of the other side by clicking cards, confirm.
 *
 * Enter adds, Escape closes. Past BULK_LINK_CONFIRM_ABOVE links it asks first;
 * past BULK_LINK_MAX it refuses and says how to narrow.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { BULK_LINK_MAX, type LinkPair, type PairVerdict } from '@/lib/bulkLinks'
import { BulkLinkFlow } from './BulkLinkFlow'
import { useBulkLinkStore } from './bulkLinkStore'
import { useBulkLinkModel } from './useBulkLinkModel'

const CARD_W = 340

export interface BulkLinkCardProps {
  selection: readonly string[]
  labelFor: (id: string) => string
  onCreate: (pairs: LinkPair[], edgeType: string) => { staged: number; rejected: PairVerdict[] }
  onClose: () => void
}

export function BulkLinkCard({ selection, labelFor, onCreate, onClose }: BulkLinkCardProps) {
  const model = useBulkLinkModel(selection)
  const anchor = useBulkLinkStore((s) => s.anchor)
  const swap = useBulkLinkStore((s) => s.swap)
  const setChosenType = useBulkLinkStore((s) => s.setChosenType)
  const pickingOnCanvas = useBulkLinkStore((s) => s.pickingOnCanvas)
  const setPickingOnCanvas = useBulkLinkStore((s) => s.setPickingOnCanvas)
  const expandToPanel = useBulkLinkStore((s) => s.expandToPanel)
  const [confirming, setConfirming] = useState(false)
  const [showSkipped, setShowSkipped] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const selected = useMemo(() => new Set(selection), [selection])
  const verdictByPair = useMemo(() => new Map(model.verdicts.map((v) => [`${v.source}\u0000${v.target}`, v])), [model.verdicts])
  const verdictOf = (s: string, t: string): 'ok' | 'skip' | undefined => {
    const v = verdictByPair.get(`${s}\u0000${t}`)
    return v ? (v.ok ? 'ok' : 'skip') : undefined
  }
  const skippedPairs = model.verdicts.filter((v) => !v.ok)
  const count = model.toCreate.length
  const otherSide = model.direction === 'selection-feeds' ? 'targets' : 'sources'
  const canAdd = !!model.edgeType && count > 0 && !model.overMax

  const create = () => {
    if (!canAdd || !model.edgeType) return
    if (model.needsConfirm && !confirming) {
      setConfirming(true)
      return
    }
    onCreate(model.toCreate.map(({ source, target }) => ({ source, target })), model.edgeType)
    onClose()
  }
  const createRef = useRef(create)
  useLayoutEffect(() => { createRef.current = create })

  // Keys for the card, wherever focus is — except inside a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      else if (e.key === 'Enter' && !(t && t.tagName === 'BUTTON')) { e.preventDefault(); createRef.current() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => { rootRef.current?.focus() }, [])

  // Beside the drop, kept on screen.
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const left = Math.max(12, Math.min((anchor?.x ?? vw / 2) + 14, vw - CARD_W - 12))
  const top = Math.max(12, Math.min((anchor?.y ?? vh / 2) + 14, vh - 360))

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-label={`Link ${model.sources.length} to ${model.targets.length}`}
      className="fixed z-[70] rounded-2xl bg-canvas-elevated border border-glass-border shadow-2xl shadow-black/15 dark:shadow-black/50 outline-none"
      style={{ left, top, width: CARD_W }}
    >
      <div className="flex items-center gap-2 px-3.5 pt-3">
        <LucideIcons.Link2 className="w-4 h-4 text-accent-lineage" strokeWidth={2.2} aria-hidden />
        <h2 className="text-[13px] font-semibold text-ink">
          {count > 0 ? `Add ${count.toLocaleString()} ${count === 1 ? 'link' : 'links'}` : 'Nothing to add yet'}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto p-1 rounded-md text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
        >
          <LucideIcons.X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="px-3.5 pt-2.5">
        <BulkLinkFlow
          compact
          sources={model.sources}
          targets={model.targets}
          selection={selected}
          labelFor={labelFor}
          lookOf={model.lookOf}
          verdictOf={verdictOf}
          relationship={model.relationship}
          onSwap={() => { setConfirming(false); swap() }}
        />
      </div>

      <div className="px-3.5 pt-3">
        {model.options.length === 0 ? (
          <p className="flex items-start gap-1.5 text-[11.5px] text-ink">
            <LucideIcons.AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0 text-amber-500" aria-hidden />
            <span>{model.noFitReason ?? `Choose the ${otherSide}.`}</span>
          </p>
        ) : (
          <label className="flex items-center gap-2 text-[11.5px] text-ink-muted">
            As
            <select
              value={model.edgeType ?? ''}
              onChange={(e) => { setConfirming(false); setChosenType(e.target.value) }}
              className="min-w-0 flex-1 px-2 py-1 rounded-lg bg-black/[0.04] dark:bg-white/[0.05] border border-glass-border text-[12px] font-medium text-ink outline-none focus:border-accent-lineage/50"
            >
              {model.options.map((o) => (
                <option key={o.edgeType} value={o.edgeType}>
                  {o.label} — fits {o.fits} of {model.pairs.length}
                </option>
              ))}
            </select>
          </label>
        )}

        {skippedPairs.length > 0 && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setShowSkipped((v) => !v)}
              aria-expanded={showSkipped}
              className="flex items-center gap-1 text-[11.5px] font-medium text-amber-600 dark:text-amber-400 hover:underline"
            >
              <LucideIcons.ChevronRight className={cn('w-3 h-3 transition-transform', showSkipped && 'rotate-90')} aria-hidden />
              {skippedPairs.length.toLocaleString()} will be skipped
            </button>
            {showSkipped && (
              <ul className="mt-1 max-h-28 overflow-y-auto custom-scrollbar space-y-1 pl-4">
                {skippedPairs.map((v) => (
                  <li key={`${v.source}\u0000${v.target}`} className="text-[11px] leading-snug">
                    <span className="text-ink">{labelFor(v.source)} → {labelFor(v.target)}</span>
                    {v.reason && <span className="block text-ink-muted">{v.reason}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 px-3.5 pt-3">
        <button
          type="button"
          onClick={() => setPickingOnCanvas(!pickingOnCanvas)}
          aria-pressed={pickingOnCanvas}
          className={cn(
            'flex items-center gap-1 px-2 py-1 rounded-lg text-[11.5px] font-medium transition-colors',
            pickingOnCanvas ? 'bg-accent-lineage/10 text-accent-lineage' : 'text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/10',
          )}
        >
          <LucideIcons.MousePointerClick className="w-3.5 h-3.5" aria-hidden />
          {pickingOnCanvas ? `Click cards to add ${otherSide}` : `Add ${otherSide}`}
        </button>
        <button
          type="button"
          onClick={expandToPanel}
          className="ml-auto px-2 py-1 rounded-lg text-[11.5px] font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
        >
          More options…
        </button>
      </div>

      <div className="flex items-center gap-2 mt-3 px-3.5 py-2.5 border-t border-glass-border">
        <p className="min-w-0 flex-1 text-[11px] text-ink-muted leading-snug" aria-live="polite">
          {model.overMax
            ? `At most ${BULK_LINK_MAX.toLocaleString()} in one go — narrow either side.`
            : confirming
              ? `Add all ${count.toLocaleString()} to your draft?`
              : 'Enter to add · Esc to close'}
        </p>
        {confirming && (
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="px-2 py-1 rounded-lg text-[12px] text-ink-muted hover:text-ink transition-colors"
          >
            Back
          </button>
        )}
        <button
          type="button"
          onClick={create}
          disabled={!canAdd}
          className="px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-accent-lineage text-white shadow-sm hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/50 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {confirming ? 'Yes, add them' : count > 0 ? `Add ${count.toLocaleString()}` : 'Add'}
        </button>
      </div>
    </div>
  )
}
