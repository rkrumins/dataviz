/* eslint-disable react-refresh/only-export-components -- standalone
   entry point rendered by lens-harness.html; fast refresh is moot. */
/**
 * Visual harness for the Lineage Lens.
 *
 * Renders the REAL lens — shell, session hook, merge core, builder and
 * graph body — against a scripted in-memory provider, so the whole
 * pipeline runs end-to-end with no backend. It exists because unit
 * tests pass over pictures that are wrong to look at: overgrown frames,
 * dead controls, unreadable labels. Screenshots are the assertion.
 *
 *   npm run harness          # serve, then open
 *   http://localhost:5199/lens-harness.html?fixture=app
 *   npm run harness:shot     # Chromium PNGs of every fixture → .harness/
 */
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/globals.css'
import { LineageLens } from '../components/canvas/context-view/LineageLens'
import { EMPTY_LENS_HISTORY, type LensHistory } from '../components/canvas/context-view/lens/lensHistory'
import { LensGraphView } from '../components/canvas/context-view/lens/LensGraphView'
import {
  createLensSession,
  expansionKeyOf,
  mergeAncestors,
  mergeChildren,
  mergeDegrees,
  mergeExpansion,
  mergeNodes,
} from '../components/canvas/context-view/lens/lensGraph'
import type { LensSessionApi } from '../components/canvas/context-view/lens/useLensSession'
import { ProviderOverride } from '../providers/GraphProviderContext'
import { useSchemaStore } from '../store/schema'
import { usePreferencesStore } from '../store/preferences'
import { FIXTURES, harnessProvider } from './lensFixtures'

// Deterministic camera for screenshots: every fit lands instantly, so a
// capture can never race a d3-zoom transition mid-flight.
usePreferencesStore.setState({ reducedMotion: true })

const params = new URLSearchParams(window.location.search)
const fixtureName = params.get('fixture') ?? 'app'
const fixture = FIXTURES[fixtureName]

// The ontology the fixtures speak — the same classification the real
// backend serves via /metadata/schema.
useSchemaStore.setState({
  schema: {
    containmentEdgeTypes: ['CONTAINS'],
    lineageEdgeTypes: ['FLOWS_TO', 'CONSUMES', 'AGGREGATED'],
    entityTypes: [
      { id: 'domain', name: 'Domain', hierarchy: { canContain: ['dataPlatform', 'system', 'app'], canBeContainedBy: [] } },
      { id: 'dataPlatform', name: 'Platform', hierarchy: { canContain: ['dataset', 'schema'], canBeContainedBy: ['domain'] } },
      { id: 'system', name: 'System', hierarchy: { canContain: ['dataset'], canBeContainedBy: ['domain'] } },
      { id: 'app', name: 'Application', hierarchy: { canContain: [], canBeContainedBy: ['domain'] } },
      { id: 'schema', name: 'Schema', hierarchy: { canContain: ['dataset'], canBeContainedBy: ['dataPlatform'] } },
      { id: 'dataset', name: 'Dataset', hierarchy: { canContain: ['column'], canBeContainedBy: ['schema', 'dataPlatform', 'system'] } },
      { id: 'column', name: 'Column', hierarchy: { canContain: [], canBeContainedBy: ['dataset'] } },
      { id: 'dashboard', name: 'Dashboard', hierarchy: { canContain: [], canBeContainedBy: ['domain'] } },
    ],
    relationshipTypes: [
      { id: 'CONTAINS', name: 'Contains', isContainment: true },
      { id: 'FLOWS_TO', name: 'Flows to', isLineage: true },
      { id: 'CONSUMES', name: 'Consumes', isLineage: true },
      { id: 'AGGREGATED', name: 'Rolled up', isLineage: true },
    ],
  },
} as never)

/** Fully synchronous session for view-layer isolation: the exact merge
 *  pipeline, no async, no provider — if THIS renders wrong, the bug is
 *  in the view mapping; if right, it's in the update path. */
function staticSession(): LensSessionApi {
  const OPTS = { containmentEdgeTypes: ['CONTAINS'] }
  const n = (urn: string, entityType: string, displayName: string) =>
    ({ urn, entityType, displayName, properties: {} })
  let seq = 0
  const e = (s: string, t: string, edgeType: string) =>
    ({ id: `s${seq++}`, sourceUrn: s, targetUrn: t, edgeType })
  let st = createLensSession('app')
  st = mergeNodes(st, [
    n('app', 'app', 'Customer Portal'),
    n('ds', 'dataset', 'gold.dim_customer'),
    n('c1', 'column', 'email'),
    n('c2', 'column', 'lifetime_value'),
    n('lone', 'dataset', 'mart.rpt_360'),
  ])
  st = mergeExpansion(st, expansionKeyOf('down', 'app'), 'app', {
    rawEdges: [e('app', 'ds', 'CONSUMES'), e('app', 'c1', 'CONSUMES'), e('app', 'c2', 'CONSUMES'), e('app', 'lone', 'CONSUMES')],
    rawTruncated: false,
    trace: {
      nodes: [], edges: [],
      containmentEdges: [e('ds', 'c1', 'CONTAINS'), e('ds', 'c2', 'CONTAINS')],
      upstreamUrns: new Set(), downstreamUrns: new Set(),
      focus: { urn: 'app', level: 1, entityType: 'app' },
      effectiveLevel: 1, isInherited: false, inheritedFromUrn: null,
      truncated: false, truncationReason: null,
    },
  }, OPTS)
  st = mergeExpansion(st, expansionKeyOf('up', 'app'), 'app', { rawEdges: [], rawTruncated: false, trace: null }, OPTS)
  st = mergeAncestors(st, 'app', [n('dom', 'domain', 'Retail Domain')])
  st = mergeChildren(st, 'ds', {
    children: [n('c1', 'column', 'email'), n('c2', 'column', 'lifetime_value'), n('c3', 'column', 'segment')],
    containmentEdges: [e('ds', 'c1', 'CONTAINS'), e('ds', 'c2', 'CONTAINS'), e('ds', 'c3', 'CONTAINS')],
    lineageEdges: [],
    totalChildren: 3, hasMore: false, nextCursor: null,
  }, OPTS)
  st = mergeDegrees(st, { app: { in: 0, out: 4 }, ds: { in: 6, out: 2 }, c1: { in: 2, out: 1 } })
  const noop = () => {}
  return {
    state: st,
    expandLineage: noop, openChildren: noop, loadMoreChildren: noop,
    connectedExpand: async () => ({ records: 0, capped: false }),
    drillRollup: noop, retryExpansion: noop, retryChildren: noop,
  }
}

function StaticHarness() {
  const [session] = useState(staticSession)
  return (
    <div className="fixed inset-4 rounded-xl border border-black/10 bg-canvas">
      <LensGraphView session={session} onFocus={() => {}} />
    </div>
  )
}

function Harness() {
  const [entry] = useState(() => (fixture ? fixture() : null))
  const [history, setHistory] = useState<LensHistory>(() =>
    entry ? { entries: [entry.focal], cursor: 0 } : EMPTY_LENS_HISTORY,
  )
  if (!entry) {
    return (
      <div style={{ padding: 24, fontFamily: 'monospace' }}>
        Unknown fixture "{fixtureName}". Available: {Object.keys(FIXTURES).join(', ')}
      </div>
    )
  }
  return (
    <ProviderOverride
      value={{
        provider: harnessProvider(entry.world),
        isLoading: false,
        error: null,
        scopeKind: 'ready',
        workspaceId: 'harness',
        dataSourceId: null,
        providerReady: true,
        providerVersion: 1,
      }}
    >
      <LineageLens
        history={history}
        onHistoryChange={setHistory}
        onClose={() => setHistory(EMPTY_LENS_HISTORY)}
      />
    </ProviderOverride>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {fixtureName === 'static' ? <StaticHarness /> : <Harness />}
  </StrictMode>,
)
