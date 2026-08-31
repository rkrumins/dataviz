/**
 * A LABEL WITH NO NODES IS NOT AN AGGREGATION LEVEL.
 *
 * `db.labels()` keeps a label forever — FalkorDB never drops one when its last
 * node is deleted — so the ontology the app introspects from the graph can
 * contain types nothing is filed under. `SentinelMarker`, left behind by a
 * test, was one: zero nodes, `hierarchy.level: 0`, `behavior.traceable: true`.
 * The real level-0 type, `domain`, is `traceable: false` and was filtered out,
 * so the zombie won the coarsest-first auto-select in ContextViewCanvas and
 * every `/graph/edges/aggregated` request in the app went out asking to be
 * rolled up to a level that held nothing.
 *
 * The granularity has no surface of its own to assert on. The dock's
 * "Hierarchy level" select is `!nativeMode`-only and the canvas always passes
 * `nativeMode`, so it never renders; the value lives in `useAggregatedLineage`
 * local state. Its ONE observable is the thing that actually broke — what the
 * canvas puts on the wire — so that is what these read, off the harness
 * provider's `getAggregatedEdges`.
 *
 * Driven on the real canvas in browse mode, because the auto-select depends on
 * the ontology and the loaded nodes agreeing, and only the canvas holds both.
 * The fetch is debounced 300 ms behind the tree settling, so each spec waits
 * past it rather than calling `settle()` (which barely advances the clock).
 *
 * NOT covered, deliberately: the `presentEntityTypes.size === 0` pass-through.
 * With no nodes on the canvas the aggregated effect returns before it fetches,
 * so that branch has no observable behaviour to pin from here.
 */
import { act } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { renderCanvasWithTrace, type TraceCanvasHarness } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'
import { useSchemaStore } from '@/store/schema'

/** An ontology entity type in the shape the schema store holds. */
const et = (id: string, level: number, traceable: boolean) => ({
  id, name: id, hierarchy: { level }, behavior: { traceable }, visual: {}, properties: [],
})

/**
 * The estate's types, plus whatever zombies a spec wants. cfoEstate files its
 * entities under dataPlatform / container / dataset / dashboard / chart /
 * schemaField; `domain` is the real level-0 type and, like the live ontology's,
 * it is not traceable.
 */
function ontology(...extra: ReturnType<typeof et>[]) {
  return [
    ...extra,
    et('domain', 0, false),
    et('dataPlatform', 1, true),
    et('container', 2, true),
    et('dataset', 3, true),
    et('dashboard', 3, true),
    et('chart', 4, true),
    et('schemaField', 5, true),
  ]
}

/** Mount the browse canvas on `types`, then let the debounced fan-out fire. */
async function canvasOn(types: ReturnType<typeof et>[]): Promise<TraceCanvasHarness> {
  const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
  act(() => {
    const { schema } = useSchemaStore.getState()
    useSchemaStore.setState({ schema: { ...schema, entityTypes: types } } as never)
  })
  await h.settle()
  // Past the 300 ms aggregation debounce.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)) })
  await h.settle()
  return h
}

beforeEach(() => {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
})

describe('the canvas never aggregates at a level nothing is filed under', () => {
  it('ignores a zombie label that is both the coarsest and traceable', async () => {
    // SentinelMarker outranks every real type on level and passes the
    // traceable gate. The only thing wrong with it is that the canvas holds
    // no entity of that type.
    const h = await canvasOn(ontology(et('SentinelMarker', 0, true)))

    const asked = h.aggregatedGranularities()
    expect(asked.length).toBeGreaterThan(0)
    expect(asked).not.toContain('SentinelMarker')
    // The coarsest type that IS on the canvas: tableau and snowflake are
    // dataPlatform, and domain — coarser still — is not traceable.
    expect(asked).toEqual(asked.map(() => 'dataPlatform'))
  })

  it('holds even when several zombies sit above the real levels', async () => {
    const h = await canvasOn(ontology(
      et('SentinelMarker', 0, true),
      et('LoadTestRoot', 0, true),
      et('MigrationScratch', 1, true),
    ))

    const asked = h.aggregatedGranularities()
    expect(asked.length).toBeGreaterThan(0)
    for (const zombie of ['SentinelMarker', 'LoadTestRoot', 'MigrationScratch']) {
      expect(asked).not.toContain(zombie)
    }
    expect(asked).toEqual(asked.map(() => 'dataPlatform'))
  })

  it('still picks the coarsest level when that level IS on the canvas', async () => {
    // The rule is "coarsest PRESENT", not "never the coarsest" and not "always
    // level 1". Move `container` — which the estate does file entities under
    // (INTERMEDIATE_T2, REPORTING) — above dataPlatform and it must win.
    const h = await canvasOn([
      et('SentinelMarker', 0, true),
      et('container', 1, true),
      et('dataPlatform', 2, true),
      et('dataset', 3, true),
      et('dashboard', 3, true),
      et('chart', 4, true),
      et('schemaField', 5, true),
    ])

    const asked = h.aggregatedGranularities()
    expect(asked.length).toBeGreaterThan(0)
    expect(asked).toEqual(asked.map(() => 'container'))
  })
})
