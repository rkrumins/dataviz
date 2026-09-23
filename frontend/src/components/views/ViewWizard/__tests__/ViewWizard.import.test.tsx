/**
 * ViewWizard — the Import journey, end to end through the wizard's own wiring.
 *
 * The file and match steps are REAL (they are what this journey adds); the steps it shares with
 * building a view are stubbed, as in ViewWizard.test.tsx. The transfer service is mocked at its
 * boundary. Pinned here:
 *   - a new view: File → Target → Match → … → Preview, and the request that imports it carries
 *     the file's definition untouched (display rules, unknown keys and all) with no origin copy;
 *   - a view that already exists here: the Target step is skipped, the update is reconciled
 *     against that view, and the import names the design it was reviewed against;
 *   - a view that changed since it was reviewed is sent back to the Match step to check again.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ImportViewResult, InspectResult, ReconcileResult,
} from '@/services/viewTransferApiService'

const inspectMock = vi.fn()
const reconcileMock = vi.fn()
const importMock = vi.fn()
const getViewMock = vi.fn()

vi.mock('@/services/viewTransferApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/viewTransferApiService')>()
  return {
    ...actual,
    inspectViewFile: (...args: unknown[]) => inspectMock(...args),
    reconcileViews: (...args: unknown[]) => reconcileMock(...args),
    importView: (...args: unknown[]) => importMock(...args),
    newRequestId: () => 'req-test-0001',
  }
})
vi.mock('@/services/viewApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/viewApiService')>()
  return { ...actual, getView: (...args: unknown[]) => getViewMock(...args), listViews: vi.fn().mockResolvedValue({ items: [] }) }
})
vi.mock('@/services/telemetryService', () => ({ recordEvent: vi.fn() }))
vi.mock('@/components/schema/SchemaScope', () => ({
  SchemaScope: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@/store/workspaces', () => {
  const state = {
    activeWorkspaceId: null,
    activeDataSourceId: null,
    workspaces: [
      { id: 'ws1', name: 'UAT', dataSources: [{ id: 'ds1', label: 'Lineage', isPrimary: true, ontologyId: 'onto1' }] },
    ],
    loadWorkspaces: vi.fn().mockResolvedValue(undefined),
  }
  const useWorkspacesStore = Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state,
  })
  return { useWorkspacesStore }
})
vi.mock('../steps/BasicsStep', () => ({ BasicsStep: () => <div data-testid="basics-step" /> }))
vi.mock('../steps/LayoutStep', () => ({ LayoutStep: () => <div data-testid="layout-step" /> }))
vi.mock('../steps/EntitiesStep', () => ({ EntitiesStep: () => <div data-testid="entities-step" /> }))
vi.mock('../steps/PreviewStep', () => ({ PreviewStep: () => <div data-testid="preview-step" /> }))
vi.mock('../steps/AssignmentStep', () => ({ AssignmentStep: () => <div data-testid="assignment-step" /> }))
vi.mock('../steps/ScopeStep', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../steps/ScopeStep')>()
  return {
    ...actual,
    ScopeStep: ({ aboveSlot }: { aboveSlot?: React.ReactNode }) => <div data-testid="scope-step">{aboveSlot}</div>,
  }
})

import { ViewTransferError } from '@/services/viewTransferApiService'
import { ViewWizard } from '../ViewWizard'

const DEFINITION = {
  layout: {
    type: 'reference',
    referenceLayout: {
      layers: [{ id: 'l1', name: 'Sources', order: 0, entityTypes: ['dataset'] }],
      assignments: { 'urn:a': { layerId: 'l1', inheritsChildren: true }, 'urn:gone': { layerId: 'l1', inheritsChildren: true } },
      displayRules: [{ id: 'hot', op: 'color', value: '#f00' }],
    },
  },
  content: { entityScope: 'curated', visibleEntityTypes: ['dataset'], visibleRelationshipTypes: [] },
  filters: { fieldFilters: [] },
  futureSetting: { kept: true },
}

function inspected(matches: InspectResult['identityMatches'] = {}): InspectResult {
  return {
    bundle: {
      format: 'view-bundle', formatVersion: 1, exportedAt: '2026-09-20T10:00:00Z',
      exportedBy: { displayName: 'Dana' }, generator: { product: 'Lineage', environment: 'dev' },
      sources: { s1: { workspace: { name: 'Dev' }, dataSource: { label: 'Lineage', providerType: 'falkordb', graphName: 'lineage' }, ontology: {} } },
      bundleHash: 'sha256:bundle',
    },
    integrity: 'verified',
    notices: [],
    views: [{
      index: 0, source: 's1', portableId: 'pv_1', sourceViewId: 'view_dev', version: 7,
      definitionHash: 'sha256:file', actualHash: 'sha256:file', integrity: 'verified',
      metadata: { name: 'Finance lineage', description: 'What feeds revenue', icon: 'Layout', tags: ['finance'], viewType: 'reference' },
      definition: DEFINITION,
      manifest: { counts: { layers: 1, assignments: 2 }, entities: { 'urn:gone': { name: 'gone table', type: 'dataset' } }, entitiesResolved: true },
      history: [{ hash: 'sha256:file', version: 7, environment: 'dev' }],
      historyTruncated: false,
    }],
    identityMatches: matches,
    targetSuggestions: { s1: [{ workspaceId: 'ws1', dataSourceId: 'ds1', label: 'Lineage', score: 70, reasons: ['Same graph'], sampleSize: 2, sampleHitRate: 0.5 }] },
  }
}

function reconciled(update: ReconcileResult['views'][0]['update'] = null): ReconcileResult {
  const counts = { total: 2, matched: 1, renamed: 0, typeChanged: 0, missing: 1, unknown: 0, found: 1, checked: 2, matchRate: 0.5 }
  return {
    views: [{
      key: '0', effectiveDefinition: DEFINITION, effectiveHash: 'sha256:file', update,
      report: {
        summary: {
          entities: counts, byKind: {}, entityTypes: { total: 1, missing: 0 }, relationshipTypes: { total: 0, missing: 0 },
          layers: { total: 1, healthy: 0 }, displayRules: 1, urnPatterns: 0, matchRate: 0.5, coverage: 1,
          verdict: 'attention', verdictReason: '1 of 2 entities aren’t here.',
        },
        entities: [{ urn: 'urn:gone', status: 'missing', kinds: ['assignment'], layerId: 'l1', exported: { name: 'gone table', type: 'dataset' }, target: null }],
        entitiesTruncated: false,
        types: { entity: [{ id: 'dataset', status: 'present', suggestions: [], layers: ['Sources'] }], relationship: [] },
        layers: [{ id: 'l1', name: 'Sources', ...counts, anchor: null, healthy: false }],
        notices: [],
      },
    }],
    aggregate: { entities: counts, verdicts: { attention: 1 }, views: 1 },
  }
}

function imported(viewId: string): ImportViewResult {
  return {
    viewId,
    view: { id: viewId, name: 'Finance lineage', workspaceId: 'ws1', viewType: 'reference', config: {}, visibility: 'private' } as ImportViewResult['view'],
    version: { version: 1, contentHash: 'sha256:file', name: 'Finance lineage', tags: [], source: 'import', stats: {}, createdAt: '2026-09-20T10:00:00Z' },
    report: reconciled().views[0].report,
    notices: [],
    integrity: { submittedHash: 'sha256:file', storedHash: 'sha256:file', verified: true, adjusted: false, adjustments: [] },
  }
}

function renderImport(props: Partial<React.ComponentProps<typeof ViewWizard>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const file = new File([JSON.stringify({ format: 'view-bundle' })], 'finance.v7.view.json', { type: 'application/json' })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ViewWizard mode="create" isOpen onClose={vi.fn()} journey="import" importFile={file}
          initialWorkspaceId="ws1" initialDataSourceId="ds1" {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function next() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled())
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ViewWizard — Import journey', () => {
  it('imports a new view with the file’s design exactly as it came', async () => {
    inspectMock.mockResolvedValue(inspected())
    reconcileMock.mockResolvedValue(reconciled())
    importMock.mockResolvedValue(imported('view_new'))
    renderImport()

    expect(await screen.findByText('Finance lineage')).toBeInTheDocument()
    expect(screen.getByText('Create a new view')).toBeInTheDocument()
    await next()                                          // → Target
    expect(await screen.findByTestId('scope-step')).toBeInTheDocument()
    expect(screen.getByText('Suggested for this file')).toBeInTheDocument()
    await next()                                          // → Match
    expect(await screen.findByText('How it fits here')).toBeInTheDocument()
    expect(reconcileMock).toHaveBeenCalledWith([expect.objectContaining({
      action: 'create', target: { workspaceId: 'ws1', dataSourceId: 'ds1' }, history: ['sha256:file'],
    })])
    expect(screen.getByText('gone table')).toBeInTheDocument()

    for (const step of ['basics-step', 'layout-step', 'assignment-step', 'entities-step', 'preview-step']) {
      await next()
      await screen.findByTestId(step)
    }
    fireEvent.click(screen.getByRole('button', { name: /Import View/ }))

    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(1))
    const [request] = importMock.mock.calls[0]
    expect(request).toMatchObject({
      action: 'create',
      target: { workspaceId: 'ws1', dataSourceId: 'ds1' },
      metadata: { name: 'Finance lineage', description: 'What feeds revenue', tags: ['finance'], viewType: 'reference', visibility: 'private' },
      origin: { portableId: 'pv_1', version: 7, environment: 'dev', fileName: 'finance.v7.view.json' },
      requestId: 'req-test-0001',
      expectedTargetHash: null,
    })
    expect(request.definition).toEqual(DEFINITION)
    expect(request.originDefinition).toBeUndefined()
    expect(await screen.findByText(/Integrity verified/)).toBeInTheDocument()
  })

  it('updates the view that is already here, skipping the target', async () => {
    inspectMock.mockResolvedValue(inspected({
      pv_1: [{ viewId: 'view_uat', name: 'Finance (UAT)', workspaceId: 'ws1', workspaceName: 'UAT', dataSourceId: 'ds1', headVersion: 3, canEdit: true, status: 'fast_forward' }],
    }))
    getViewMock.mockResolvedValue({ id: 'view_uat', name: 'Finance (UAT)', workspaceId: 'ws1', dataSourceId: 'ds1', viewType: 'reference', config: { icon: 'Layout' }, tags: [], visibility: 'workspace' })
    const update = {
      status: 'fast_forward' as const, base: { version: 3, hash: 'sha256:old' }, targetHead: { version: 3, hash: 'sha256:old' },
      targetWorkingHash: 'sha256:old', mergeAvailable: false, strategy: 'replace' as const, conflicts: [],
      diff: {
        metadata: [], layers: { added: [], removed: [], changed: [], reordered: false },
        assignments: { added: 1, removed: 0, moved: 0, modified: 0, samples: { added: [], removed: [], moved: [], modified: [] }, truncated: false },
        settings: [], identical: false,
      },
    }
    reconcileMock.mockResolvedValue(reconciled(update))
    importMock.mockResolvedValue(imported('view_uat'))
    renderImport()

    expect(await screen.findByText('Update “Finance (UAT)”')).toBeInTheDocument()
    await next()                                          // straight to Match
    expect(await screen.findByText('Updating “Finance (UAT)”')).toBeInTheDocument()
    expect(screen.queryByTestId('scope-step')).not.toBeInTheDocument()
    expect(reconcileMock).toHaveBeenCalledWith([expect.objectContaining({ action: 'update', target: { viewId: 'view_uat' } })])

    for (const step of ['basics-step', 'layout-step', 'assignment-step', 'entities-step', 'preview-step']) {
      await next()
      await screen.findByTestId(step)
    }
    fireEvent.click(screen.getByRole('button', { name: /Update View/ }))
    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(1))
    const [request] = importMock.mock.calls[0]
    expect(request).toMatchObject({ action: 'update', target: { viewId: 'view_uat' }, expectedTargetHash: 'sha256:old' })
    // An update keeps the view's current name unless the file's was chosen, and leaves visibility alone.
    expect(request.metadata.name).toBe('Finance (UAT)')
    expect(request.metadata.visibility).toBeUndefined()
  })

  it('sends a view that changed since it was reviewed back to be checked again', async () => {
    inspectMock.mockResolvedValue(inspected())
    reconcileMock.mockResolvedValue(reconciled())
    importMock.mockRejectedValueOnce(new ViewTransferError('“Finance lineage” changed after you reviewed it.', 409, 'target_changed'))
    renderImport()

    await screen.findByText('Create a new view')
    await next()
    await next()
    await screen.findByText('How it fits here')
    for (const step of ['basics-step', 'layout-step', 'assignment-step', 'entities-step', 'preview-step']) {
      await next()
      await screen.findByTestId(step)
    }
    fireEvent.click(screen.getByRole('button', { name: /Import View/ }))
    expect(await screen.findByText(/changed after you reviewed it/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^retry$/i }))
    expect(await screen.findByText('How it fits here')).toBeInTheDocument()
    await waitFor(() => expect(reconcileMock).toHaveBeenCalledTimes(2))
  })
})
