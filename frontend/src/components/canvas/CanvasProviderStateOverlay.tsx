/**
 * CanvasProviderStateOverlay — the premium, reassuring state card shown over a
 * canvas when its graph provider is warming up (loading its dataset after a
 * restart) or briefly unavailable. Replaces the flat "Provider Unavailable"
 * box. Design goals:
 *   - Calm & premium: a glass state-card on a dimmed/blurred canvas, matching
 *     the app's canvas/glass/accent-lineage language — never alarming, because
 *     the data is safe.
 *   - Explanatory: says plainly what's happening, that data is safe, and what
 *     happens next (auto-retry) + an explicit "Retry now".
 *   - Smooth: React.memo'd so canvas re-renders can't restart the loader, and
 *     the loader animates on transform ONLY (compositor/GPU) so it stays
 *     buttery even while the main thread is busy hydrating.
 *   - Clickable: sits at z-50 ABOVE the canvas columns (z-30) with a
 *     pointer-capturing backdrop, so "Retry now" is always hittable (the old
 *     z-20 overlay was rendered BEHIND the z-30 columns → dead button).
 */
import React from 'react'
import { RefreshCw, WifiOff } from 'lucide-react'
import { cn } from '@/lib/utils'

const ACCENT = 'var(--nx-accent-lineage, #6366f1)'

const STYLE = `
@keyframes canvas-state-in {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
/* Graph-constellation loader — edges "draw in", nodes pulse, on a stagger, so
   the mark reads as a small graph assembling itself. transform/opacity/
   stroke-dashoffset only → runs on the compositor, stays smooth under load. */
@keyframes canvas-graph-draw {
  0%   { stroke-dashoffset: 44; opacity: 0.15; }
  45%  { stroke-dashoffset: 0;  opacity: 0.85; }
  75%  { stroke-dashoffset: 0;  opacity: 0.85; }
  100% { stroke-dashoffset: 44; opacity: 0.15; }
}
@keyframes canvas-graph-pulse {
  0%, 100% { transform: scale(0.7);  opacity: 0.5; }
  50%      { transform: scale(1.15); opacity: 1; }
}
@keyframes canvas-graph-halo {
  0%, 100% { transform: scale(0.6); opacity: 0.3; }
  50%      { transform: scale(1.3); opacity: 0.7; }
}
.cv-edge { stroke: ${ACCENT}; stroke-width: 1.6; stroke-linecap: round; fill: none;
  stroke-dasharray: 44; stroke-dashoffset: 44; animation: canvas-graph-draw 2.4s ease-in-out infinite; }
.cv-node { fill: ${ACCENT}; transform-box: fill-box; transform-origin: center;
  animation: canvas-graph-pulse 2.4s ease-in-out infinite; }
.cv-halo { fill: rgba(99,102,241,0.16); transform-box: fill-box; transform-origin: center;
  animation: canvas-graph-halo 2.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .cv-edge, .cv-node, .cv-halo { animation: none; opacity: 0.85; stroke-dashoffset: 0; }
}
`

/** Thematic loader: a small node-graph that assembles itself (edges draw in,
 *  nodes pulse) — on-brand for "loading your graph", and animated purely on
 *  transform/opacity/stroke-dashoffset so it never janks. */
function WarmingLoader() {
  return (
    <svg className="h-[68px] w-[68px]" viewBox="0 0 72 72" aria-hidden="true" style={{ willChange: 'transform' }}>
      <line className="cv-edge" x1="36" y1="20" x2="20" y2="40" style={{ animationDelay: '0s' }} />
      <line className="cv-edge" x1="36" y1="20" x2="52" y2="40" style={{ animationDelay: '.3s' }} />
      <line className="cv-edge" x1="20" y1="40" x2="36" y2="56" style={{ animationDelay: '.6s' }} />
      <line className="cv-edge" x1="52" y1="40" x2="36" y2="56" style={{ animationDelay: '.9s' }} />
      <line className="cv-edge" x1="20" y1="40" x2="52" y2="40" style={{ animationDelay: '1.2s' }} />
      <circle className="cv-halo" cx="36" cy="20" r="9" />
      <circle className="cv-node" cx="36" cy="20" r="4.2" style={{ animationDelay: '0s' }} />
      <circle className="cv-node" cx="20" cy="40" r="4.2" style={{ animationDelay: '.3s' }} />
      <circle className="cv-node" cx="52" cy="40" r="4.2" style={{ animationDelay: '.6s' }} />
      <circle className="cv-node" cx="36" cy="56" r="4.2" style={{ animationDelay: '.9s' }} />
    </svg>
  )
}

/** Unavailable mark: amber offline glyph with a breathing halo. */
function UnavailableMark() {
  return (
    <div className="relative flex h-16 w-16 items-center justify-center">
      <div className="absolute inset-0 rounded-full bg-amber-400/10 animate-pulse" />
      <div className="absolute inset-2 rounded-full border border-amber-400/25" />
      <WifiOff className="relative h-6 w-6 text-amber-500" strokeWidth={2} />
    </div>
  )
}

export interface CanvasProviderStateOverlayProps {
  /** true = provider loading its dataset (transient); false = hard unavailable. */
  warming: boolean
  onRetry?: () => void
}

export const CanvasProviderStateOverlay = React.memo(function CanvasProviderStateOverlay({
  warming,
  onRetry,
}: CanvasProviderStateOverlayProps) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center px-6">
      <style>{STYLE}</style>
      {/* Dimmed, blurred backdrop — captures pointer events so the empty canvas
          underneath isn't interactive while a provider state is showing. */}
      <div className="absolute inset-0 bg-canvas/70 backdrop-blur-md" />

      <div
        role="status"
        aria-live="polite"
        className={cn(
          'relative w-full max-w-md overflow-hidden rounded-3xl',
          'border border-glass-border bg-canvas-elevated/90 backdrop-blur-2xl',
          'shadow-2xl shadow-black/25',
        )}
        style={{ animation: 'canvas-state-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) both' }}
      >
        {/* Hairline accent along the top edge, tinted per state. */}
        <div
          className={cn(
            'absolute inset-x-0 top-0 h-px',
            warming
              ? 'bg-gradient-to-r from-transparent via-accent-lineage/70 to-transparent'
              : 'bg-gradient-to-r from-transparent via-amber-400/70 to-transparent',
          )}
        />
        {/* Soft radial atmosphere behind the mark. */}
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute -top-16 left-1/2 h-40 w-40 -translate-x-1/2 rounded-full blur-3xl',
            warming ? 'bg-accent-lineage/20' : 'bg-amber-400/15',
          )}
        />

        <div className="relative flex flex-col items-center gap-5 px-8 pb-8 pt-9 text-center">
          {warming ? <WarmingLoader /> : <UnavailableMark />}

          <div className="space-y-2">
            <h3 className="text-lg font-semibold tracking-tight text-ink">
              {warming ? 'Preparing your graph' : 'Graph service is unavailable'}
            </h3>
            <p className="mx-auto max-w-xs text-sm leading-relaxed text-ink-muted">
              {warming ? (
                <>Your data is safe — we’re loading it from the graph service. This usually takes a few seconds after it restarts.</>
              ) : (
                <>The graph service isn’t responding right now. <span className="text-ink">Nothing has been lost</span> — this view fills in the moment the service is back.</>
              )}
            </p>
          </div>

          {/* Live status line. */}
          <div className="flex items-center gap-2 text-xs font-medium text-ink-muted/80">
            <span
              className={cn(
                'inline-block h-1.5 w-1.5 rounded-full animate-pulse',
                warming ? 'bg-accent-lineage' : 'bg-amber-400',
              )}
            />
            {warming ? 'Retrying automatically…' : 'Watching for recovery…'}
          </div>

          {onRetry && (
            <button
              onClick={onRetry}
              className={cn(
                'group mt-1 inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold',
                'transition-all duration-200 active:scale-[0.97]',
                warming
                  ? 'border border-glass-border text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
                  : 'bg-accent-lineage text-white shadow-lg shadow-accent-lineage/25 hover:brightness-110',
              )}
            >
              <RefreshCw className="h-4 w-4 transition-transform duration-500 group-hover:rotate-180" />
              Retry now
            </button>
          )}
        </div>
      </div>
    </div>
  )
})
