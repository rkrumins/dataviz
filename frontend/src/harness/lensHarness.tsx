/**
 * Visual harness for the Lens graph body.
 *
 * Renders the REAL `FocusGraphView` against a hand-built fixture and
 * nothing else — no API, no canvas, no providers. It exists because the
 * unit tests all passed over a frame that grew to 1,030px, two controls
 * that did nothing, and a provenance ribbon that truncated itself into
 * `TRA…`. None of those are assertable without looking.
 *
 *   npx vite --config vite.config.ts --port 5199
 *   open http://localhost:5199/lens-harness.html?fixture=columns
 *
 * `npm run harness:shot` drives Chromium over every fixture and writes
 * PNGs to .harness/.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import '../styles/globals.css'
import { FocusGraphView } from '../components/canvas/context-view/lens/FocusGraphView'
import { buildFocusGraph, type FocusGraphInput } from '../components/canvas/context-view/lens/focus-graph'
import { deriveNeighborRecords } from '@/lib/lineage-neighbors'
import type { LineageEdge } from '@/store/canvas'
import { FIXTURES } from './lensFixtures'

const CONTAINMENT = ['CONTAINS']

function buildGraph(fixture: (typeof FIXTURES)[string]) {
  const { focal, nodes, edges, isCoarser, canContain, over } = fixture
  const nodeMap = new Map(nodes.map(n => [n.id, n]))
  const edgesByEndpoint = new Map<string, LineageEdge[]>()
  for (const e of edges) {
    for (const k of e.source === e.target ? [e.source] : [e.source, e.target]) {
      const list = edgesByEndpoint.get(k)
      if (list) list.push(e)
      else edgesByEndpoint.set(k, [e])
    }
  }
  const { incomingRecords, outgoingRecords } = deriveNeighborRecords(
    focal, edgesByEndpoint.get(focal) ?? [], nodeMap, CONTAINMENT,
  )
  const resolveParent = (id: string): string | null => {
    for (const e of edgesByEndpoint.get(id) ?? []) {
      if (e.target === id && e.source !== id && (e.data?.edgeType as string)?.toUpperCase() === 'CONTAINS') return e.source
    }
    return null
  }
  const containsChildren: string[] = []
  for (const e of edgesByEndpoint.get(focal) ?? []) {
    if (e.source === focal && (e.data?.edgeType as string)?.toUpperCase() === 'CONTAINS') containsChildren.push(e.target)
  }
  const input: FocusGraphInput = {
    focalId: focal,
    incomingRecords,
    outgoingRecords,
    edgesByEndpoint,
    nodeMap,
    containmentEdgeTypes: CONTAINMENT,
    containsChildren,
    resolveParent,
    isCoarser: isCoarser ?? (() => false),
    canContain: canContain ?? (() => false),
    collapsedFrames: new Set(),
    expandedFrontier: new Set(),
    openContainers: new Set(),
    entityLevels: new Map([
      ['DATADOMAIN', 0], ['DATAPLATFORM', 1], ['CONTAINER', 2],
      ['dataset', 3], ['schemaField', 4],
    ]),
    bandPages: new Map(),
    query: '',
    hiddenTypes: new Set(),
    grainFold: 'topmost',
    ...over,
  }
  // Mirror what LineageLens passes: the focal describes the BOARD, not
  // the record count, or the harness would show a discrepancy the app
  // does not have (and hide one it does).
  const graph = buildFocusGraph(input)
  return {
    graph,
    stats: {
      in: graph.bandTotals.get('band:in:1')?.connections ?? incomingRecords.length,
      out: graph.bandTotals.get('band:out:1')?.connections ?? outgoingRecords.length,
    },
  }
}

const noop = () => {}

export function Harness() {
  const name = new URLSearchParams(window.location.search).get('fixture') ?? 'columns'
  const fixture = FIXTURES[name]
  if (!fixture) {
    return <p style={{ font: '14px system-ui', padding: 24 }}>
      Unknown fixture &quot;{name}&quot;. Try: {Object.keys(FIXTURES).join(', ')}
    </p>
  }
  const { graph, stats } = buildGraph(fixture)
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--surface, #fff)' }}>
      <ReactFlowProvider>
        <FocusGraphView
          graph={graph}
          focalId={fixture.focal}
          focalStats={stats}
          focalFetch="done"
          selectedId={null}
          reducedMotion
          onSelect={noop}
          onFocus={noop}
          onToggleFrame={noop}
          onOpenContainer={noop}
          onExpandFrontier={noop}
          onToggleContains={noop}
          onRetryContains={noop}
          onShowMore={noop}
          onSetFramePage={noop}
          onFrameQuery={noop}
        />
      </ReactFlowProvider>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><Harness /></StrictMode>,
)
