/**
 * GrowReviewSheet — a grow that would bring in a lot asks first. The reader
 * sees what would come in, by layer, and can leave any of it out before it
 * joins the subset.
 *
 * The house modal shape: the scrim is a plain <Backdrop> sibling, the
 * full-viewport wrapper is inert, and only the panel takes clicks.
 */
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Sprout, X } from 'lucide-react'

import { Backdrop } from '@/components/ui/Backdrop'
import { MOTION } from '@/lib/motion'

import type { SubsetPick } from '../../model/studioStore'
import { LayerDot, OriginBadge, QUIET_BUTTON, type StudioLayer } from './atoms'

const PER_LAYER_CAP = 200

export function GrowReviewSheet({ title, additions, layers, onConfirm, onCancel }: {
  title: string
  additions: readonly SubsetPick[]
  layers: readonly StudioLayer[]
  onConfirm: (chosen: SubsetPick[]) => void
  onCancel: () => void
}) {
  const [left, setLeft] = useState<ReadonlySet<string>>(() => new Set())
  const byLayer = useMemo(() => {
    const m = new Map<string, SubsetPick[]>()
    for (const a of additions) {
      const list = m.get(a.layerId)
      if (list) list.push(a)
      else m.set(a.layerId, [a])
    }
    return layers.filter(l => m.has(l.id)).map(l => ({ layer: l, rows: m.get(l.id)! }))
  }, [additions, layers])
  const chosen = additions.filter(a => !left.has(a.urn))

  const toggle = (urns: string[], on: boolean) => setLeft(prev => {
    const next = new Set(prev)
    for (const u of urns) {
      if (on) next.delete(u)
      else next.add(u)
    }
    return next
  })

  return createPortal(
    <>
      <Backdrop open onClick={onCancel} zClassName="z-[80]" className="bg-black/50" />
      <div className="fixed inset-0 z-[81] flex items-center justify-center p-4 pointer-events-none">
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-labelledby="subset-grow-review-title"
          initial={{ scale: 0.96, opacity: 0, y: 8 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          transition={MOTION.modalSpring}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }}
          className="pointer-events-auto w-full max-w-md max-h-[80vh] flex flex-col rounded-2xl bg-canvas-elevated border border-black/[0.08] dark:border-white/[0.08] shadow-2xl shadow-black/30 overflow-hidden"
        >
          <div className="flex items-start gap-3 px-5 pt-4 pb-3 border-b border-black/[0.08] dark:border-white/[0.08]">
            <span className="mt-0.5 w-9 h-9 flex-shrink-0 rounded-xl bg-accent-explore/15 grid place-items-center">
              <Sprout className="w-[18px] h-[18px] text-accent-explore" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="subset-grow-review-title" className="text-[14px] font-semibold text-ink leading-tight">{title}</h2>
              <p className="mt-0.5 text-[12px] text-ink-muted">
                {additions.length.toLocaleString()} entities would come in. Leave out any you don&apos;t need.
              </p>
            </div>
            <button type="button" onClick={onCancel} aria-label="Close" className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>

          <div className="min-h-0 overflow-y-auto custom-scrollbar px-5 py-3 space-y-3">
            {byLayer.map(({ layer, rows }) => {
              const on = rows.filter(r => !left.has(r.urn)).length
              return (
                <section key={layer.id} aria-label={layer.name}>
                  <label className="flex items-center gap-2 pb-1 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={on === rows.length}
                      ref={(el) => { if (el) el.indeterminate = on > 0 && on < rows.length }}
                      onChange={(e) => toggle(rows.map(r => r.urn), e.target.checked)}
                      className="accent-[#06b6d4]"
                    />
                    <LayerDot color={layer.color} />
                    <span className="text-[12px] font-semibold text-ink">{layer.name}</span>
                    <span className="text-[11px] text-ink-muted tabular-nums">{on.toLocaleString()} of {rows.length.toLocaleString()}</span>
                  </label>
                  <ul className="rounded-lg border border-black/[0.08] dark:border-white/[0.08] divide-y divide-black/[0.06] dark:divide-white/[0.06] overflow-hidden">
                    {rows.slice(0, PER_LAYER_CAP).map(r => (
                      <li key={r.urn}>
                        <label className="flex items-center gap-2 px-2.5 py-1.5 min-w-0 cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.03]">
                          <input
                            type="checkbox"
                            checked={!left.has(r.urn)}
                            onChange={(e) => toggle([r.urn], e.target.checked)}
                            className="accent-[#06b6d4]"
                          />
                          <span className="truncate text-[12px] text-ink" title={r.label}>{r.label}</span>
                          <OriginBadge origin={r.origin} />
                          {r.entityType && <span className="ml-auto flex-shrink-0 text-[10px] uppercase tracking-wider text-ink-muted">{r.entityType}</span>}
                        </label>
                      </li>
                    ))}
                  </ul>
                  {rows.length > PER_LAYER_CAP && (
                    <p className="px-1 pt-1 text-[10.5px] text-ink-muted">+{(rows.length - PER_LAYER_CAP).toLocaleString()} more in this layer come in with it</p>
                  )}
                </section>
              )
            })}
          </div>

          <div className="flex items-center gap-2 px-5 py-3 border-t border-black/[0.08] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.02]">
            <p className="min-w-0 flex-1 text-[12px] text-ink-muted" aria-live="polite">
              {chosen.length.toLocaleString()} will be added
            </p>
            <button type="button" onClick={onCancel} className={QUIET_BUTTON}>Cancel</button>
            <button
              type="button"
              onClick={() => onConfirm(chosen)}
              disabled={chosen.length === 0}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-[12.5px] font-semibold text-white bg-accent-explore hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/50"
            >
              Add {chosen.length.toLocaleString()}
            </button>
          </div>
        </motion.div>
      </div>
    </>,
    document.body,
  )
}
