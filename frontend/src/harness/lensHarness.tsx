/**
 * Visual harness for the Lens graph body.
 *
 * Renders the REAL `FocusGraphView` against a hand-built walk model and
 * nothing else — no API, no canvas, no providers. It exists because the
 * unit tests all passed over a frame that grew to 1,030px, two controls
 * that did nothing, and a provenance ribbon that truncated itself into
 * `TRA…`. None of those are assertable without looking.
 *
 *   npx vite --config vite.config.ts --port 5199
 *   open http://localhost:5199/lens-harness.html?fixture=walkCollaterals
 *
 * `npm run harness:shot` drives Chromium over every fixture and writes
 * PNGs to .harness/.
 *
 * `&perf=1` (Task 20, P0) additionally runs a real-Chromium rAF sampler —
 * see `usePaintSampler` below — for the paint-side numbers jsdom cannot
 * produce at all (jsdom does no layout or compositing). `&isolate=<cardId>`
 * overrides the fixture's own isolation, so any fixture can be sampled
 * with its off-cone treatment active at full board scale.
 */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import '../styles/globals.css'
import { FocusGraphView } from '../components/canvas/context-view/lens/FocusGraphView'
import { WALK_FIXTURES } from './lensFixtures'
import { buildWalk } from './buildWalk'

/**
 * Steady-state PAINT cost, sampled the only place it is real: a browser
 * that actually composites. Settles past the initial mount (so first
 * layout never dominates the numbers), then averages `requestAnimationFrame`
 * deltas over a fixed window — the direct comparison P2 needs for "does
 * removing `filter` in favour of opacity + a precomputed muted colour
 * measurably help", before vs after, same fixture, same machine, same
 * session. Reported as text ON the page so the existing screenshot-only
 * harness captures it — no new Chromium-driving script needed.
 */
function usePaintSampler(enabled: boolean): string | null {
  const [report, setReport] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const settle = window.setTimeout(() => {
      const deltas: number[] = []
      let last = performance.now()
      const windowStart = last
      const SAMPLE_MS = 1200
      const tick = (t: number) => {
        if (cancelled) return
        deltas.push(t - last)
        last = t
        if (t - windowStart < SAMPLE_MS) {
          requestAnimationFrame(tick)
          return
        }
        const sorted = [...deltas].sort((a, b) => a - b)
        const avg = deltas.reduce((a, b) => a + b, 0) / (deltas.length || 1)
        const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
        const max = sorted[sorted.length - 1] ?? 0
        const over16 = deltas.filter(d => d > 16.7).length
        const text = `frames=${deltas.length} avgMs=${avg.toFixed(2)} p95Ms=${p95.toFixed(2)} maxMs=${max.toFixed(2)} over16ms=${over16}`
        setReport(text)
        document.title = text
      }
      requestAnimationFrame(tick)
    }, 500)
    return () => { cancelled = true; window.clearTimeout(settle) }
  }, [enabled])
  return report
}

const noop = () => {}

export function Harness() {
  const params = new URLSearchParams(window.location.search)
  // Read and the hook called BEFORE the "unknown fixture" early return —
  // a hook after a conditional return is called on some renders and not
  // others, which is the one thing React's rules forbid.
  const perfMode = params.get('perf') === '1'
  const perfReport = usePaintSampler(perfMode)
  const name = params.get('fixture') ?? 'walkCollaterals'
  const fixture = WALK_FIXTURES[name]
  if (!fixture) {
    return <p style={{ font: '14px system-ui', padding: 24 }}>
      Unknown fixture &quot;{name}&quot;. Try: {Object.keys(WALK_FIXTURES).join(', ')}
    </p>
  }
  const built = buildWalk(fixture)
  // `&isolate=<cardId>` overrides the fixture's own isolation — see
  // usePaintSampler's doc comment. `card id` is `n:${urn}` for a plain
  // node (focus-layout.ts:1264), the same scheme every isolatedId in
  // lensFixtures.ts already uses.
  const isolateOverride = params.get('isolate')
  const isolatedId = isolateOverride ?? built.isolatedId
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--surface, #fff)' }}>
      <ReactFlowProvider>
        <FocusGraphView
          graph={built.graph}
          focalId={built.focalId}
          focalFetch="done"
          focalReach={built.reach}
          directionFilter={built.directionFilter}
          selectedId={built.selectedId}
          isolatedId={isolatedId}
          trailUrns={built.trailUrns}
          trailAdjacent={built.trailAdjacent}
          // Shots are taken with motion OFF, so a screenshot is never a
          // frame of an animation — except where the motion is the thing
          // being looked at. The drift along an isolated cone is drawn
          // with dashes, and a still of it is exactly readable. A perf
          // sample wants the REAL steady-state cost, animation included.
          reducedMotion={isolatedId === null && !perfMode}
          onSelect={noop}
          onFocus={noop}
          onToggleFrame={noop}
          onFrameScroll={noop}
          onFrameQuery={noop}
          onToggleFrameAll={noop}
          onRevealMore={noop}
          onExtend={noop}
          onPage={noop}
        />
      </ReactFlowProvider>
      {perfReport && (
        <pre
          style={{
            position: 'fixed', top: 8, left: 8, margin: 0, padding: '6px 10px',
            background: '#000', color: '#0f0', font: '12px/1.4 monospace',
            borderRadius: 6, zIndex: 9999,
          }}
        >
          {perfReport}
        </pre>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><Harness /></StrictMode>,
)
