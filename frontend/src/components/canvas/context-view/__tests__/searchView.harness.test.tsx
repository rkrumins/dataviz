/**
 * A subset view on the REAL Context View canvas: its layers list a search's
 * matches, counted as the server counts them.
 *  - a layer's header reads what it lists of how many; a capped layer says how
 *    many it shows and offers Search in this layer for the rest;
 *  - a layer with no matches says so;
 *  - each row is drawn in the layer whose feed listed it, as its base places it
 *    — never moved by its type, nor into a loaded container's column;
 *  - while it follows its base, its layers are the base's: no Add layer, even
 *    in a draft;
 *  - with the preview off, the canvas says why it lists nothing.
 */
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useSearchStore } from '@/store/searchStore'
import { useCanvasStore } from '@/store/canvas'
import { useFeaturesStore } from '@/store/features'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { toCanvasEdge, toCanvasNode, withFeedLayer } from '@/lib/canvasNodeMapper'
import type { GraphNode } from '@/providers/GraphDataProvider'
import type { SearchViewDefinition } from '@/types/searchView'

const SEARCH: SearchViewDefinition = {
  v: 1, predicate: { kind: 'tag', values: ['pii'] } as never, within: 'view', readIn: 'v-base', layout: 'inherit',
  provenance: { origin: 'search', viewId: 'v-base' },
}

function setPreview(on: boolean) {
  useFeaturesStore.setState({ values: { ...useFeaturesStore.getState().values, searchViewsEnabled: on } } as never)
}

/** Where each layer's feed stands, as hydration leaves it. */
function seedFeeds() {
  const search = (layerId: string, delivered: number, capped: boolean) => ({
    layerId, cursor: capped ? null : 'c', sessionId: null, status: 'complete' as const, countStatus: 'exact' as const,
    stale: false, asOf: null, capped, delivered,
  })
  useCanvasStore.setState((s) => ({
    typeFeeds: {
      ...s.typeFeeds,
      'layer:warehouse': { entityTypes: [], offset: 2000, hasMore: false, total: 80412, search: search('warehouse', 2000, true) },
      'layer:report': { entityTypes: [], offset: 0, hasMore: false, total: 0, search: search('report', 0, false) },
    },
  }))
}

const column = (name: string) => {
  const header = screen.getAllByText(name).find((el) => el.closest('[data-layer-id]'))
  const el = header?.closest('[data-layer-id]') as HTMLElement | null
  if (!el) throw new Error(`no column ${name}`)
  return el
}

describe('A subset view on the canvas', () => {
  afterEach(() => {
    setPreview(false)
    useCanvasStore.setState({ typeFeeds: {} })
    useCanvasStore.getState().setSubsetIssue(null)
  })

  it('counts each layer’s matches, and offers a way to the rest of a capped one', async () => {
    setPreview(true)
    const requestSearchRun = vi.fn()
    const realRun = useSearchStore.getState().requestSearchRun
    useSearchStore.setState({ requestSearchRun } as never)
    try {
      const h = await renderCanvasWithTrace(cfoEstate(), {
        focus: 'cfo', deferTrace: true, entityScope: 'all', subset: SEARCH,
        // The report layer's entities aren't among the matches.
        browseHolds: ['INTERMEDIATE_T2', 'REPORTING'],
      })
      await act(async () => { seedFeeds() })
      await h.settle()

      const warehouse = column('Warehouse')
      expect(within(warehouse).getByTitle('2,000 of 80,412 matches in this layer')).toHaveTextContent('2,000/80,412')
      expect(within(warehouse).getByText('Showing 2,000 of 80,412')).toBeInTheDocument()
      await act(async () => { fireEvent.click(within(warehouse).getByRole('button', { name: /Search in this layer/ })) })
      expect(requestSearchRun).toHaveBeenCalledWith({ kind: 'layer', layerAssignment: 'warehouse' }, 'header')

      expect(within(column('Report')).getByText('No matches')).toBeInTheDocument()
    } finally {
      useSearchStore.setState({ requestSearchRun: realRun } as never)
    }
  }, 40000)

  it('draws each row in the layer whose feed listed it, whatever its type or its container', async () => {
    setPreview(true)
    const h = await renderCanvasWithTrace(cfoEstate(), {
      focus: 'cfo', deferTrace: true, entityScope: 'all', subset: SEARCH,
    })
    // Two matches the base places by hand: a database in Warehouse, and a table
    // inside it in Report, though Warehouse holds its type.
    const row = (urn: string, label: string, layerId: string) =>
      toCanvasNode(withFeedLayer({ urn, displayName: label, entityType: 'container' } as GraphNode, layerId))
    await act(async () => {
      useCanvasStore.getState().addGraph(
        [row('urn:oracle', 'oracle_prod', 'warehouse'), row('urn:orders', 'oracle_orders', 'report')],
        [toCanvasEdge({ id: 'c:oracle>orders', sourceUrn: 'urn:oracle', targetUrn: 'urn:orders',
                        edgeType: 'CONTAINS' } as never)])
    })
    await h.settle()
    expect(within(column('Warehouse')).getByText('oracle_prod')).toBeInTheDocument()
    expect(within(column('Report')).getByText('oracle_orders')).toBeInTheDocument()
    expect(within(column('Warehouse')).queryByText('oracle_orders')).toBeNull()
  }, 40000)

  it('takes its layers from its base while it follows it: no Add layer, even in a draft', async () => {
    setPreview(true)
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', deferTrace: true, draft: true, entityScope: 'all', subset: SEARCH })
    await h.settle()
    expect(screen.queryByText('Add layer')).toBeNull()
  }, 40000)

  it('an ordinary view in a draft still offers Add layer', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', deferTrace: true, draft: true })
    await h.settle()
    expect(screen.getByText('Add layer')).toBeInTheDocument()
  }, 40000)

  it('with the preview off, says why it lists nothing', async () => {
    setPreview(false)
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', deferTrace: true, entityScope: 'all', subset: SEARCH })
    await h.settle()
    expect(screen.getByText('Subset views are turned off')).toBeInTheDocument()
  }, 40000)
})
