/**
 * SubsetStudioPanel — carve a smaller view out of the one on screen.
 *
 * A right rail beside the live source canvas (it shrinks the canvas rather
 * than covering it, like the Property Manager): the reader picks on the
 * canvas itself, and the rail guides them through three steps —
 *
 *   1. Pick     what the subset holds: clicks, whole layers or types, and
 *               growing the picks along their lineage;
 *   2. Connect  how the picks will hang together: direct lineage, virtual
 *               hops over what was left out, anything isolated;
 *   3. Shape    layers, contents, groups and how far a virtual hop reaches.
 *
 * — then "Save as view…" hands the picks to the create dialog. The steps
 * are tabs, not a gate: a reader can look at Connect after every pick.
 */
import { useMemo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ScissorsLineDashed, X } from 'lucide-react'

import { HoverTip } from '@/components/ui/HoverTip'
import { cn } from '@/lib/utils'
import { MOTION } from '@/lib/motion'
import type { LineageBridgeLink } from '@/providers/GraphDataProvider'

import type { LineageBridgesState } from '../hooks/useLineageBridges'
import type { GrowDepth, GrowDirection } from '../model/grow'
import { SUBSET_MEMBERS_MAX } from '../model/limits'
import { summarizeConnectivity } from '../model/connectivity'
import { useSubsetStudioStore, type StudioStep, type SubsetPick } from '../model/studioStore'
import type { StudioLayer } from './studio/atoms'
import { ConnectStep } from './studio/ConnectStep'
import { PickStep } from './studio/PickStep'
import { ShapeStep } from './studio/ShapeStep'

export interface SubsetStudioPanelProps {
  open: boolean
  sourceName: string
  layers: readonly StudioLayer[]
  layerCandidates: ReadonlyMap<string, readonly SubsetPick[]>
  containerUrns: ReadonlySet<string>
  preview: LineageBridgesState
  onGrow: (direction: GrowDirection, depth: GrowDepth) => void
  growing: boolean
  growBlockedReason?: string
  onOpenHop: (link: LineageBridgeLink, point: { x: number; y: number }) => void
  onLocate: (urn: string) => void
  /** Open the create dialog; absent while making views is not offered. */
  onSave?: () => void
}

const STEPS: Array<{ id: StudioStep; label: string }> = [
  { id: 'pick', label: 'Pick' },
  { id: 'connect', label: 'Connect' },
  { id: 'shape', label: 'Shape' },
]

export function SubsetStudioPanel({
  open, sourceName, layers, layerCandidates, containerUrns, preview,
  onGrow, growing, growBlockedReason, onOpenHop, onLocate, onSave,
}: SubsetStudioPanelProps) {
  const step = useSubsetStudioStore((s) => s.step)
  const order = useSubsetStudioStore((s) => s.order)
  const setStep = useSubsetStudioStore((s) => s.setStep)
  const confirmingCancel = useSubsetStudioStore((s) => s.confirmingCancel)
  const requestCancel = useSubsetStudioStore((s) => s.requestCancel)
  const dismissCancel = useSubsetStudioStore((s) => s.dismissCancel)
  const discard = () => useSubsetStudioStore.getState().close({ discard: true })

  const count = order.length
  const layerCount = useMemo(() => {
    const picks = useSubsetStudioStore.getState().picks
    return new Set(order.map(u => picks[u]?.layerId)).size
  }, [order])
  const virtualCount = useMemo(
    () => summarizeConnectivity(order, preview.links, preview.incomplete).virtual.length,
    [order, preview.links, preview.incomplete],
  )

  const saveBlocked = count === 0
    ? 'Pick at least one entity first'
    : count > SUBSET_MEMBERS_MAX
      ? `A subset holds at most ${SUBSET_MEMBERS_MAX.toLocaleString()} entities`
      : null

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          key="subset-studio"
          aria-label="Subset studio"
          data-panel="subset-studio"
          data-canvas-interactive
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 'clamp(360px, 28vw, 440px)', opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={MOTION.drawerSlide}
          className="relative h-full flex-shrink-0 overflow-hidden bg-canvas-elevated border-l border-black/[0.08] dark:border-white/[0.08] shadow-lg shadow-black/20"
        >
          <div className="w-[clamp(360px,28vw,440px)] h-full flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex-shrink-0 px-4 pt-4 pb-3 border-b border-black/[0.08] dark:border-white/[0.08] bg-gradient-to-br from-accent-explore/10 to-transparent">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 w-9 h-9 flex-shrink-0 rounded-xl bg-accent-explore/15 grid place-items-center">
                  <ScissorsLineDashed className="w-[18px] h-[18px] text-accent-explore" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[14px] font-semibold text-ink leading-tight">Subset studio</h2>
                  <p className="mt-0.5 text-[11.5px] text-ink-muted truncate" title={sourceName}>
                    A smaller view, carved from {sourceName}
                  </p>
                </div>
                <HoverTip label="Close the studio" detail={count > 0 ? 'You will be asked before your picks are discarded' : undefined}>
                  <button
                    type="button"
                    onClick={requestCancel}
                    aria-label="Close the subset studio"
                    className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/40"
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                </HoverTip>
              </div>

              {/* Steps — tabs, each one open at any time */}
              <div role="tablist" aria-label="Subset steps" className="mt-3 grid grid-cols-3 gap-1 p-1 rounded-xl bg-black/[0.04] dark:bg-white/[0.05]">
                {STEPS.map((s, i) => {
                  const current = step === s.id
                  const done = (s.id === 'pick' && count > 0 && step !== 'pick')
                  return (
                    <button
                      key={s.id}
                      type="button"
                      role="tab"
                      id={`subset-step-${s.id}`}
                      aria-selected={current}
                      aria-controls="subset-step-panel"
                      onClick={() => setStep(s.id)}
                      className={cn(
                        'flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-[12px] font-medium transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/40',
                        current ? 'bg-canvas-elevated text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'w-4 h-4 rounded-full grid place-items-center text-[9.5px] font-bold',
                          current ? 'bg-accent-explore text-white' : done ? 'bg-lineage-out text-white' : 'border border-black/[0.08] dark:border-white/[0.08]',
                        )}
                      >
                        {done ? <Check className="w-2.5 h-2.5" strokeWidth={3} /> : i + 1}
                      </span>
                      {s.label}
                    </button>
                  )
                })}
              </div>

              <p aria-live="polite" className="mt-2.5 text-[11.5px] text-ink-secondary tabular-nums">
                {count === 0
                  ? 'Nothing picked yet'
                  : `${count.toLocaleString()} ${count === 1 ? 'entity' : 'entities'} · ${layerCount} ${layerCount === 1 ? 'layer' : 'layers'}`
                    + (virtualCount > 0 ? ` · ${virtualCount.toLocaleString()} virtual ${virtualCount === 1 ? 'hop' : 'hops'}` : '')}
              </p>
            </div>

            {/* The step */}
            <div
              id="subset-step-panel"
              role="tabpanel"
              aria-labelledby={`subset-step-${step}`}
              className="min-h-0 flex-1 overflow-y-auto custom-scrollbar px-4 py-4"
            >
              {step === 'pick' && (
                <PickStep
                  layers={layers}
                  layerCandidates={layerCandidates}
                  onGrow={onGrow}
                  growing={growing}
                  growBlockedReason={growBlockedReason}
                  onLocate={onLocate}
                />
              )}
              {step === 'connect' && <ConnectStep layers={layers} preview={preview} onOpenHop={onOpenHop} onLocate={onLocate} />}
              {step === 'shape' && <ShapeStep layers={layers} containerUrns={containerUrns} />}
            </div>

            {/* Footer */}
            <div className="flex-shrink-0 px-4 py-3 border-t border-black/[0.08] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.02]">
              {confirmingCancel ? (
                <div className="flex items-center gap-2" role="alert">
                  <p className="min-w-0 flex-1 text-[12px] text-ink">
                    Discard {count.toLocaleString()} {count === 1 ? 'pick' : 'picks'}?
                  </p>
                  <button
                    type="button"
                    onClick={dismissCancel}
                    className="px-3 py-1.5 rounded-lg text-[12.5px] text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                  >
                    Keep picking
                  </button>
                  <button
                    type="button"
                    onClick={discard}
                    className="px-3 py-1.5 rounded-lg text-[12.5px] font-semibold text-white bg-red-500 hover:bg-red-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
                  >
                    Discard
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={requestCancel}
                    className="px-3 py-1.5 rounded-lg text-[12.5px] text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                  >
                    Cancel
                  </button>
                  {onSave && (
                    <HoverTip
                      className="ml-auto inline-flex"
                      label={saveBlocked ?? 'Name the subset and choose who sees it'}
                      detail={saveBlocked ? undefined : 'The source view stays exactly as it is'}
                    >
                      <button
                        type="button"
                        onClick={onSave}
                        disabled={!!saveBlocked}
                        aria-disabled={!!saveBlocked}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-[12.5px] font-semibold text-white bg-accent-explore shadow-sm hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/50"
                      >
                        <ScissorsLineDashed className="w-3.5 h-3.5" aria-hidden="true" />
                        Save as view…
                        {count > 0 && <span className="tabular-nums opacity-80">({count.toLocaleString()})</span>}
                      </button>
                    </HoverTip>
                  )}
                </div>
              )}
            </div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
