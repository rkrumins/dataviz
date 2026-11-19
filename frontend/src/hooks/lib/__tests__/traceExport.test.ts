/**
 * traceExport — the trace on screen, as a file.
 *
 * The file is the board's scope, not the walk's and not the reader's open
 * cards: the sides being read, the hop limits, the seeds still in the trace.
 * A closed card is still in it; a host is the path of the rows inside it,
 * never a row; a chain the view cannot place is counted, never invented.
 */
import { describe, it, expect } from 'vitest'
import { buildTraceView, type TraceViewInputs } from '../traceViewModel'
import {
  TRACE_FLOW_COLUMNS,
  traceCsvLines,
  traceExportEdges,
  traceExportFilename,
  traceExportRows,
  traceFlowCsvLines,
  traceFlowRows,
  traceJsonParts,
  traceMembershipSpec,
  type TraceExportMeta,
} from '../traceExport'
import { twoSeedEstate } from '@/test/fixtures/traceEstates'

const two = twoSeedEstate()
const SEEDS = ['orders', 'sales']

const viewOf = (over: Partial<TraceViewInputs> = {}) => buildTraceView({
  model: two.model, focusUrn: 'orders', focusUrns: SEEDS, layers: two.layers, assignments: two.assignments,
  viewIsCurated: true, traceExpansion: new Set(), showUpstream: true, showDownstream: true,
  depthUp: 25, depthDown: 25,
  ...over,
})

const rowsOf = (over: Partial<TraceViewInputs> = {}) => {
  const view = viewOf(over)
  return traceExportRows({
    view,
    model: two.model,
    seeds: SEEDS,
    showUpstream: over.showUpstream ?? true,
    showDownstream: over.showDownstream ?? true,
    layerName: id => (id === 'warehouse' ? 'Warehouse' : id),
    seedModels: new Map([['orders', two.modelA], ['sales', two.modelB]]),
  })
}
const byUrn = (rows: ReturnType<typeof rowsOf>) => new Map(rows.map(r => [r.urn, r]))

describe('the rows are what the trace shows', () => {
  it('every entity on the trace, open or not — seeds, what is inside them, and each side', () => {
    const rows = byUrn(rowsOf())
    expect(rows.get('orders')?.role).toBe('seed')
    expect(rows.get('sales')?.role).toBe('seed')
    expect(rows.get('orders.amt')?.role).toBe('inside-seed')
    expect(rows.get('ledger.amt')).toMatchObject({ role: 'upstream', hops: 1, hopsUp: 1, hopsDown: null })
    expect(rows.get('audit.amt')).toMatchObject({ role: 'upstream', hops: 2 })
    expect(rows.get('dash.amt')).toMatchObject({ role: 'downstream', hops: 1 })
    // Nothing was opened, and every row is still in the file.
    expect(viewOf().visible.has('audit.amt')).toBe(false)
  })

  it('a host is a row’s path, never a row of its own', () => {
    const rows = byUrn(rowsOf())
    expect(rows.has('RAW')).toBe(false)
    expect(rows.has('FIN')).toBe(false)
    expect(rows.get('ledger.amt')).toMatchObject({ layer: 'Warehouse', path: ['FIN', 'ledger'] })
  })

  it('says where each row sits: its parent, and every container down to it, by name and URN', () => {
    const rows = byUrn(rowsOf())
    expect(rows.get('ledger.amt')).toMatchObject({
      parentUrn: 'ledger', parentName: 'ledger', parentType: 'dataset',
      path: ['FIN', 'ledger'], pathUrns: ['FIN', 'ledger'],
    })
    expect(rows.get('sales')).toMatchObject({ parentUrn: 'MART', parentType: 'container', pathUrns: ['MART'] })
  })

  it('the whole chain, not only what this view draws, and nothing for the top of the graph', () => {
    const view = viewOf()
    const deeper = {
      ...two.model,
      nodes: [...two.model.nodes, { urn: 'WH', displayName: 'Warehouse DB', entityType: 'database', data: {} } as never],
      containmentEdges: [...two.model.containmentEdges, { sourceUrn: 'WH', targetUrn: 'FIN' }],
    }
    const rows = byUrn(traceExportRows({
      view, model: deeper, seeds: SEEDS, showUpstream: true, showDownstream: true, layerName: id => id,
    }))
    expect(rows.get('ledger.amt')).toMatchObject({ path: ['Warehouse DB', 'FIN', 'ledger'], pathUrns: ['WH', 'FIN', 'ledger'] })
    const top = traceExportRows({
      view, model: { nodes: two.model.nodes, containmentEdges: [] }, seeds: SEEDS,
      showUpstream: true, showDownstream: true, layerName: id => id,
    }).find(r => r.urn === 'orders')
    expect(top).toMatchObject({ parentUrn: null, parentName: null, parentType: null, path: [], pathUrns: [] })
  })

  it('a side switched off is not in the file, and its hops are not reported', () => {
    const rows = byUrn(rowsOf({ showDownstream: false }))
    expect(rows.has('dash.amt')).toBe(false)
    expect(rows.get('ledger.amt')?.hopsDown).toBeNull()
    expect(rows.get('orders')?.role).toBe('seed')
  })

  it('the hop limit scopes the file exactly as it scopes the board', () => {
    const rows = byUrn(rowsOf({ depthUp: 1 }))
    expect(rows.has('ledger.amt')).toBe(true)
    expect(rows.has('audit.amt')).toBe(false)
  })

  it('says which seed reaches each row', () => {
    const rows = byUrn(rowsOf())
    expect(rows.get('ledger.amt')?.reachedFrom).toEqual(['orders'])
    expect(rows.get('dash.amt')?.reachedFrom).toEqual(['sales'])
  })
})

describe('the files', () => {
  it('CSV: a header, a line a row, and no formula a spreadsheet would run', () => {
    const rows = rowsOf()
    const lines = traceCsvLines([...rows, { ...rows[0]!, name: '=HYPERLINK("x")' }])
    expect(lines[0]).toBe('urn,name,type,role,hops,hopsUp,hopsDown,layer,parentUrn,parentName,parentType,path,pathUrns,reachedFrom\r\n')
    expect(lines).toHaveLength(rows.length + 2)
    expect(lines.at(-1)).toContain(`"'=HYPERLINK(""x"")"`)
  })

  it('JSON: parts that join into one document — meta, the spec, nodes and their flows', () => {
    const rows = rowsOf({ depthUp: 1 })
    const edges = traceExportEdges(two.model, rows)
    const meta: TraceExportMeta = {
      view: { id: 'v1', name: 'Finance' }, dataSourceId: 'ds1', generatedAt: '2026-11-18T00:00:00Z',
      seeds: SEEDS.map(urn => ({ urn, label: urn })), direction: 'both', depthUp: 1, depthDown: 25,
      walkPhase: 'done', truncated: false, outsideView: 0,
    }
    const spec = traceMembershipSpec({ urns: SEEDS, showUpstream: true, showDownstream: true, depthUp: 1, depthDown: 25 })
    const doc = JSON.parse(traceJsonParts(meta, spec, rows, edges).join(''))
    expect(doc.meta).toEqual(meta)
    expect(doc.nodes).toHaveLength(rows.length)
    // Only flows between rows of the file, and never a rollup — each with where both ends sit.
    expect(doc.edges.map((e: { source: string; target: string; type: string }) => [e.source, e.target, e.type]))
      .toEqual([['ledger.amt', 'orders.amt', 'TRANSFORMS'], ['sales.amt', 'dash.amt', 'TRANSFORMS']])
    expect(doc.edges[0]).toMatchObject({ sourceParentName: 'ledger', targetParentName: 'orders', sourcePath: ['FIN', 'ledger'] })
    // The seeds with everything inside them, as the trace shows them.
    expect(doc.spec.expand).toEqual({ children: 'all', upstream: 1, downstream: 'all', partnerChildren: 0 })
  })

  it('flows: each with both ends — what it is, its layer, its parent and every container down to it', () => {
    const rows = rowsOf()
    const flows = traceFlowRows(rows, traceExportEdges(two.model, rows))
    expect(flows.find(f => f.source === 'ledger.amt' && f.target === 'orders.amt')).toMatchObject({
      type: 'TRANSFORMS',
      sourceName: 'ledger.amt', sourceType: 'schemaField', sourceLayer: 'Warehouse',
      sourceParentUrn: 'ledger', sourceParentName: 'ledger', sourceParentType: 'dataset',
      sourcePath: ['FIN', 'ledger'], sourcePathUrns: ['FIN', 'ledger'],
      targetName: 'orders.amt', targetParentUrn: 'orders', targetParentName: 'orders', targetParentType: 'dataset',
      targetPath: ['RAW', 'orders'], targetPathUrns: ['RAW', 'orders'],
    })
    const lines = traceFlowCsvLines([...flows, { ...flows[0]!, sourceName: '@SUM(1)' }])
    expect(lines[0]).toBe(`${TRACE_FLOW_COLUMNS.join(',')}\r\n`)
    expect(lines[0]).toMatch(/^source,target,type,sourceName,/)
    expect(lines).toHaveLength(flows.length + 2)
    expect(lines[1]).toContain('FIN / ledger')
    expect(lines.at(-1)).toContain(`'@SUM(1)`)
  })

  it('an empty trace is still a valid document', () => {
    const doc = JSON.parse(traceJsonParts({} as TraceExportMeta, traceMembershipSpec({
      urns: ['x'], showUpstream: false, showDownstream: true, depthUp: 3, depthDown: 3,
    }), [], []).join(''))
    expect(doc).toMatchObject({ nodes: [], edges: [], spec: { expand: { upstream: 0, downstream: 3 } } })
  })

  it('a view keeps each seed whole; a file lists what is inside, as far as the server lists', () => {
    const t = { urns: ['x'], showUpstream: true, showDownstream: true, depthUp: 25, depthDown: 25 }
    expect(traceMembershipSpec(t).expand.children).toBe('all')
    expect(traceMembershipSpec({ ...t, listInside: true }).expand.children).toBe(2)
  })

  it('names the file for what it holds', () => {
    expect(traceExportFilename('2 entities', 'csv', new Date('2026-11-18T10:00:00Z'))).toBe('trace-2-entities-2026-11-18.csv')
    expect(traceExportFilename('***', 'json', new Date('2026-11-18T10:00:00Z'))).toBe('trace-trace-2026-11-18.json')
    expect(traceExportFilename('2 entities', 'csv', new Date('2026-11-18T10:00:00Z'), 'flows')).toBe('trace-2-entities-2026-11-18-flows.csv')
  })
})
