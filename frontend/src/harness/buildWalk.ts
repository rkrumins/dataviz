/**
 * `buildWalk` — end to end through the REAL modules: a merged walk model
 * → `buildLensSubgraph` → `initialLensViewState` (+ the fixture's
 * scripted clicks) → `buildFocusLayout` → the same props `FocusGraphView`
 * renders in production. Nothing is mocked but the callbacks, so a
 * screenshot — or a perf measurement — is evidence about the code that
 * ships rather than about the harness.
 *
 * Extracted from `lensHarness.tsx` (Task 20, P0) so the jsdom perf suite
 * (`lens/__tests__/perf.test.tsx`) can build the exact same props a
 * screenshot is taken from, without importing `lensHarness.tsx` itself —
 * that module calls `createRoot(...).render(...)` at import time, which
 * has no `#root` element in a vitest/jsdom environment.
 */
import { boundaryFrontierFilter, buildLensSubgraph, distinctSystemCount } from '@/components/canvas/context-view/lens/lens-subgraph'
import { buildFocusLayout, initialLensViewState } from '@/components/canvas/context-view/lens/focus-layout'
import { applyCondensation } from '@/components/canvas/context-view/lens/condensation'
import type { WalkFixture } from './lensFixtures'

export function buildWalk(fixture: WalkFixture) {
  const sg = buildLensSubgraph(fixture.model)
  const base = initialLensViewState(sg)
  const view = fixture.script ? fixture.script(base) : base
  const layout = buildFocusLayout({
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
  // T23 — THE SAME condensation projection `LineageLens` runs: a
  // screenshot through the raw `buildFocusLayout` output alone would
  // show no condensed runs at all, which is exactly the gap that made
  // an earlier shot of this fixture no evidence of the feature —
  // reproduced, then fixed, not assumed fixed by import order. (T28 R3
  // removed the sliding-window pass this comment used to also describe
  // — the board just grows now.)
  const condensed = applyCondensation(layout, view.condensedOpen)
  const graph = condensed
  return {
    graph,
    focalId: sg.focusUrn,
    directionFilter: fixture.directionFilter,
    selectedId: fixture.selectedId ?? null,
    isolatedId: fixture.isolatedId ?? null,
    trailUrns: new Set(fixture.trailUrns ?? []),
    trailAdjacent: new Set((fixture.trailAdjacent ?? []).map(([a, b]) => [a, b].sort().join('|'))),
    // THE SAME derivation the app uses, imported rather than restated:
    // a "+" means the data source has more of THIS SIDE, and a frontier
    // entry on a node inside the focus whose lineage never leaves it says
    // no such thing. Restating it here as `frontier.length > 0` made the
    // harness contradict the app — walkPlatformFocus's own docstring says
    // "no + on upstream Reach" and the shot showed one.
    reach: {
      up: fixture.model.upstreamUrns.size,
      down: fixture.model.downstreamUrns.size,
      moreUp: fixture.model.frontierUp.some(
        f => boundaryFrontierFilter(sg, sg.focusUrn, 'in')(f.urn)),
      moreDown: fixture.model.frontierDown.some(
        f => boundaryFrontierFilter(sg, sg.focusUrn, 'out')(f.urn)),
      upSystems: distinctSystemCount(sg, fixture.model.upstreamUrns),
      downSystems: distinctSystemCount(sg, fixture.model.downstreamUrns),
    },
  }
}
