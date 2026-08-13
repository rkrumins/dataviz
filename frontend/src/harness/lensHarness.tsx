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
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import '../styles/globals.css'
import { FocusGraphView } from '../components/canvas/context-view/lens/FocusGraphView'
import { buildLensSubgraph } from '../components/canvas/context-view/lens/lens-subgraph'
import { buildFocusLayout, initialLensViewState } from '../components/canvas/context-view/lens/focus-layout'
import { WALK_FIXTURES, type WalkFixture } from './lensFixtures'

/**
 * End to end through the REAL modules: a merged walk model →
 * `buildLensSubgraph` → `initialLensViewState` (+ the fixture's scripted
 * clicks) → `buildFocusLayout` → the same view the app renders. Nothing
 * is mocked but the callbacks, so a screenshot is evidence about the
 * code that ships rather than about the harness.
 */
function buildWalk(fixture: WalkFixture) {
  const sg = buildLensSubgraph(fixture.model)
  const base = initialLensViewState(sg)
  const view = fixture.script ? fixture.script(base) : base
  const graph = buildFocusLayout({
    sg,
    view,
    query: '',
    hiddenTypes: new Set(),
    extendStatus: fixture.extendStatus ?? new Map(),
    childrenAll: fixture.childrenAll ?? new Map(),
    childrenAllStatus: new Map(),
    walkStatus: 'done',
    directionFilter: fixture.directionFilter,
  })
  return {
    graph,
    focalId: sg.focusUrn,
    directionFilter: fixture.directionFilter,
    selectedId: fixture.selectedId ?? null,
    stats: {
      in: graph.bandTotals.get('band:in:1')?.connections ?? 0,
      out: graph.bandTotals.get('band:out:1')?.connections ?? 0,
    },
    reach: {
      up: fixture.model.upstreamUrns.size,
      down: fixture.model.downstreamUrns.size,
      moreUp: fixture.model.frontierUp.length > 0,
      moreDown: fixture.model.frontierDown.length > 0,
    },
  }
}

const noop = () => {}

export function Harness() {
  const name = new URLSearchParams(window.location.search).get('fixture') ?? 'walkCollaterals'
  const fixture = WALK_FIXTURES[name]
  if (!fixture) {
    return <p style={{ font: '14px system-ui', padding: 24 }}>
      Unknown fixture &quot;{name}&quot;. Try: {Object.keys(WALK_FIXTURES).join(', ')}
    </p>
  }
  const built = buildWalk(fixture)
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--surface, #fff)' }}>
      <ReactFlowProvider>
        <FocusGraphView
          graph={built.graph}
          focalId={built.focalId}
          focalStats={built.stats}
          focalFetch="done"
          focalReach={built.reach}
          directionFilter={built.directionFilter}
          selectedId={built.selectedId}
          reducedMotion
          onSelect={noop}
          onFocus={noop}
          onToggleFrame={noop}
          onSetFramePage={noop}
          onFrameQuery={noop}
          onToggleFrameAll={noop}
          onRevealMore={noop}
          onExtend={noop}
          onPage={noop}
        />
      </ReactFlowProvider>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><Harness /></StrictMode>,
)
