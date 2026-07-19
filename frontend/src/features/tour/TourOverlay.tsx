import { useEffect, useLayoutEffect, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { X, ArrowRight, ArrowLeft, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTourStore } from './tourStore'
import { getTour } from './tours'
import type { TourPlacement } from './types'

const CARD_W = 360
const GAP = 14

interface Box {
  top: number
  left: number
  width: number
  height: number
}

/** Tiny **bold** parser so step bodies can emphasise a phrase. */
function renderBody(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((seg, i) =>
    seg.startsWith('**') && seg.endsWith('**') ? (
      <strong key={i} className="font-semibold text-ink">{seg.slice(2, -2)}</strong>
    ) : (
      <span key={i}>{seg}</span>
    ),
  )
}

export function TourOverlay() {
  const activeTourId = useTourStore((s) => s.activeTourId)
  const stepIndex = useTourStore((s) => s.stepIndex)
  const next = useTourStore((s) => s.next)
  const prev = useTourStore((s) => s.prev)
  const goTo = useTourStore((s) => s.goTo)
  const stop = useTourStore((s) => s.stop)

  const navigate = useNavigate()
  const location = useLocation()
  const tour = activeTourId ? getTour(activeTourId) : null
  const step = tour?.steps[stepIndex]

  const [box, setBox] = useState<Box | null>(null)

  const measure = useCallback(() => {
    if (!step?.target) {
      setBox(null)
      return
    }
    const el = document.querySelector(step.target) as HTMLElement | null
    if (!el) {
      setBox(null)
      return
    }
    const r = el.getBoundingClientRect()
    const pad = step.padding ?? 8
    setBox({ top: r.top - pad, left: r.left - pad, width: r.width + pad * 2, height: r.height + pad * 2 })
  }, [step])

  // On step change: navigate if needed, then poll for the target, scroll it into
  // view, and measure. Falls back to a centered card if the target never appears.
  useEffect(() => {
    if (!step) return
    let cancelled = false
    setBox(null)

    if (step.route && location.pathname !== step.route) {
      navigate(step.route)
    }

    let tries = 0
    const tick = () => {
      if (cancelled) return
      if (!step.target) return
      const el = document.querySelector(step.target) as HTMLElement | null
      if (el) {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' })
        window.setTimeout(() => {
          if (!cancelled) measure()
        }, 320)
        return
      }
      if (tries++ < 45) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTourId, stepIndex])

  // Keep the spotlight glued to the target as the page scrolls / resizes.
  useLayoutEffect(() => {
    if (!activeTourId) return
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [activeTourId, measure])

  // Keyboard control.
  useEffect(() => {
    if (!activeTourId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stop()
      else if (e.key === 'ArrowRight' || e.key === 'Enter') next()
      else if (e.key === 'ArrowLeft') prev()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [activeTourId, next, prev, stop])

  if (!tour || !step) return null

  const isLast = stepIndex === tour.steps.length - 1
  const isFirst = stepIndex === 0

  // ── Card placement ────────────────────────────────────────────────
  const vw = window.innerWidth
  const vh = window.innerHeight
  let cardStyle: React.CSSProperties
  let caret: TourPlacement | null = null

  if (!box) {
    cardStyle = { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
  } else {
    const want = step.placement ?? 'bottom'
    const belowRoom = vh - (box.top + box.height)
    const aboveRoom = box.top
    // Choose vertical side with the most room unless a side placement is given.
    let place: TourPlacement = want
    if (want === 'bottom' && belowRoom < 200 && aboveRoom > belowRoom) place = 'top'
    if (want === 'top' && aboveRoom < 200 && belowRoom > aboveRoom) place = 'bottom'

    const cx = box.left + box.width / 2
    const clampLeft = (l: number) => Math.max(GAP, Math.min(l, vw - CARD_W - GAP))

    if (place === 'top') {
      cardStyle = { top: box.top - GAP, left: clampLeft(cx - CARD_W / 2), transform: 'translateY(-100%)' }
      caret = 'bottom'
    } else if (place === 'left') {
      cardStyle = { top: box.top, left: Math.max(GAP, box.left - CARD_W - GAP) }
      caret = 'right'
    } else if (place === 'right') {
      cardStyle = { top: box.top, left: Math.min(box.left + box.width + GAP, vw - CARD_W - GAP) }
      caret = 'left'
    } else {
      cardStyle = { top: box.top + box.height + GAP, left: clampLeft(cx - CARD_W / 2) }
      caret = 'top'
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[200]" role="dialog" aria-modal="true" aria-label={`${tour.title} tour`}>
      {/* Click-catcher — blocks interaction with the app while the tour runs. */}
      <div className="absolute inset-0" onClick={(e) => e.stopPropagation()} />

      {/* Spotlight (or full dim for element-less steps) */}
      {box ? (
        <>
          <motion.div
            className="pointer-events-none absolute rounded-xl"
            initial={false}
            animate={{ top: box.top, left: box.left, width: box.width, height: box.height }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            style={{ boxShadow: '0 0 0 9999px rgba(2, 6, 23, 0.62)' }}
          />
          <motion.div
            className="pointer-events-none absolute rounded-xl ring-2 ring-accent-lineage/80 shadow-[0_0_0_4px_rgba(99,102,241,0.18)]"
            initial={false}
            animate={{ top: box.top, left: box.left, width: box.width, height: box.height }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
          />
        </>
      ) : (
        <div className="absolute inset-0 bg-[rgba(2,6,23,0.62)]" />
      )}

      {/* Coach-mark card */}
      <AnimatePresence mode="wait">
        <motion.div
          key={stepIndex}
          initial={{ opacity: 0, y: 6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -6, scale: 0.98 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="glass-panel pointer-events-auto absolute w-[360px] max-w-[calc(100vw-2rem)] rounded-2xl border border-glass-border p-5 shadow-2xl"
          style={cardStyle}
        >
          {caret && <Caret placement={caret} />}

          <div className="flex items-start justify-between gap-3">
            <span className="inline-flex items-center gap-2 rounded-full bg-accent-lineage/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-accent-lineage">
              <tour.icon className="h-3.5 w-3.5" />
              {tour.title}
            </span>
            <button
              onClick={stop}
              aria-label="End tour"
              className="rounded-lg p-1 text-ink-muted transition-colors hover:bg-black/5 hover:text-ink dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <h3 className="mt-3 text-base font-bold text-ink">{step.title}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-secondary">{renderBody(step.body)}</p>

          {/* Progress dots */}
          <div className="mt-4 flex items-center gap-1.5">
            {tour.steps.map((_, i) => (
              <button
                key={i}
                onClick={() => goTo(i)}
                aria-label={`Go to step ${i + 1}`}
                className={cn(
                  'h-1.5 rounded-full transition-all',
                  i === stepIndex ? 'w-5 bg-accent-lineage' : 'w-1.5 bg-ink-muted/30 hover:bg-ink-muted/60',
                )}
              />
            ))}
          </div>

          {/* Controls */}
          <div className="mt-4 flex items-center justify-between">
            <span className="text-xs text-ink-muted">
              {stepIndex + 1} of {tour.steps.length}
            </span>
            <div className="flex items-center gap-2">
              {!isFirst && (
                <button onClick={prev} className="btn btn-ghost btn-sm">
                  <ArrowLeft className="h-3.5 w-3.5" /> Back
                </button>
              )}
              <button onClick={next} className="btn btn-primary btn-sm">
                {isLast ? (
                  <>
                    <Check className="h-3.5 w-3.5" /> Done
                  </>
                ) : (
                  <>
                    Next <ArrowRight className="h-3.5 w-3.5" />
                  </>
                )}
              </button>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>,
    document.body,
  )
}

/** A small caret pointing from the card toward the spotlit element. */
function Caret({ placement }: { placement: TourPlacement }) {
  const base = 'absolute w-3 h-3 rotate-45 bg-canvas-elevated border-glass-border'
  const map: Record<string, string> = {
    top: 'left-1/2 -translate-x-1/2 -top-1.5 border-l border-t',
    bottom: 'left-1/2 -translate-x-1/2 -bottom-1.5 border-r border-b',
    left: 'top-6 -left-1.5 border-l border-b',
    right: 'top-6 -right-1.5 border-r border-t',
  }
  return <span aria-hidden className={cn(base, map[placement])} />
}
