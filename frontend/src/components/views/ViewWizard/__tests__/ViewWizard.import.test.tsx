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
 *   - a view that changed since it was reviewed is sent back to the Match step to check again;
 *   - overwriting another view is offered only for a view you can edit, asked when it is picked;
 *   - entities whose lookup failed can be looked up again, one view or many;
 *   - a file of several views: every view checked in one request, then imported one request per
 *     view under one batch id; an update keeps the view's own details; a failure doesn't stop the
 *     rest and is retried under the same request id; a view switched to a copy is checked again, as
 *     is one that changed here during the import; a view to update that can't be read says so;
 *   - on a version-controlled data source, an import waits in a draft by default (or goes live,
 *     if chosen), and the view then opens on that draft; the draft can be submitted for review
 *     from there (the view opens live once it's published), and a file's views all at once,
 *     one review per view's draft;
 *   - a view with its data (a package): its data goes into a new draft of a version-controlled
 *     target, the view is checked against that draft and goes into it too, and opens there; a
 *     target that can't take the data is refused (the view alone still can be imported); and data
 *     that already went into a draft elsewhere asks for the file again; a data import that failed
 *     can be tried again, into the same draft.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ImportViewResult, InspectResult, PackageInspectResult, ReconcileResult,
} from '@/services/viewTransferApiService'

const inspectMock = vi.fn()
const reconcileMock = vi.fn()
const importMock = vi.fn()
const getViewMock = vi.fn()
const listViewsMock = vi.fn()
const inspectPackageMock = vi.fn()
const packageDataMock = vi.fn()
const getImportMock = vi.fn()
const importPreviewMock = vi.fn()
const openReviewMock = vi.fn()
let requestIds = 0
const NOT_VERSIONED = { versioned: false, allowed: false, checking: false }
let staging: typeof NOT_VERSIONED & { graphId?: string | null } = NOT_VERSIONED

vi.mock('@/services/viewTransferApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/viewTransferApiService')>()
  return {
    ...actual,
    inspectViewFile: (...args: unknown[]) => inspectMock(...args),
    inspectViewPackage: (...args: unknown[]) => inspectPackageMock(...args),
    importPackageData: (...args: unknown[]) => packageDataMock(...args),
    reconcileViews: (...args: unknown[]) => reconcileMock(...args),
    importView: (...args: unknown[]) => importMock(...args),
    newRequestId: () => `req-test-${String(++requestIds).padStart(4, '0')}`,
  }
})
vi.mock('@/services/viewApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/viewApiService')>()
  return {
    ...actual,
    getView: (...args: unknown[]) => getViewMock(...args),
    listViews: (...args: unknown[]) => listViewsMock(...args),
  }
})
vi.mock('@/services/importExportApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/importExportApiService')>()
  return {
    ...actual,
    getImport: (...args: unknown[]) => getImportMock(...args),
    getImportPreview: (...args: unknown[]) => importPreviewMock(...args),
  }
})
vi.mock('@/services/versioningApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/versioningApiService')>()
  return { ...actual, openMergeRequest: (...args: unknown[]) => openReviewMock(...args) }
})
// The publish dialog is the canvas's own (tested there): stood in for at its boundary.
vi.mock('@/features/versioning/components/PublishDraftDialog', () => ({
  PublishDraftDialog: (p: { wsId: string; graphId: string; branchId: string; onClose: () => void; onPublished?: () => void }) => (
    <div data-testid="publish-draft">
      {`${p.wsId}/${p.graphId}/${p.branchId}`}
      <button type="button" onClick={() => { p.onClose(); p.onPublished?.() }}>Publish (stub)</button>
    </div>
  ),
}))
vi.mock('@/services/telemetryService', () => ({ recordEvent: vi.fn() }))
vi.mock('../import/useDraftStaging', () => ({
  DRAFT_PERMISSION: 'workspace:datasource:manage',
  useDraftStaging: () => staging,
  useDraftStagingFor: (targets: Array<{ dataSourceId: string | null }>) =>
    Object.fromEntries(targets.filter(t => t.dataSourceId).map(t => [t.dataSourceId, staging])),
}))
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
import { PullRequestExistsError } from '@/services/versioningApiService'
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

const FAST_FORWARD = {
  status: 'fast_forward' as const, base: { version: 3, hash: 'sha256:old' }, targetHead: { version: 3, hash: 'sha256:old' },
  targetWorkingHash: 'sha256:old', mergeAvailable: false, strategy: 'replace' as const, conflicts: [],
  diff: {
    metadata: [], layers: { added: [], removed: [], changed: [], reordered: false },
    assignments: { added: 1, removed: 0, moved: 0, modified: 0, samples: { added: [], removed: [], moved: [], modified: [] }, truncated: false },
    settings: [], identical: false,
  },
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

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname + location.search}</span>
}

function renderImport(props: Partial<React.ComponentProps<typeof ViewWizard>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const file = new File([JSON.stringify({ format: 'view-bundle' })], 'finance.v7.view.json', { type: 'application/json' })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ViewWizard mode="create" isOpen onClose={vi.fn()} journey="import" importFile={file}
          initialWorkspaceId="ws1" initialDataSourceId="ds1" {...props} />
        <LocationProbe />
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
  requestIds = 0
  staging = NOT_VERSIONED
  listViewsMock.mockResolvedValue({ items: [] })
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
    reconcileMock.mockResolvedValue(reconciled(FAST_FORWARD))
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
  it('overwrites only a view you can edit, and says so of one you can’t', async () => {
    inspectMock.mockResolvedValue(inspected())
    listViewsMock.mockResolvedValue({ items: [
      { id: 'view_ro', name: 'Read-only view', workspaceId: 'ws1', workspaceName: 'UAT', dataSourceId: 'ds1' },
      { id: 'view_rw', name: 'Editable view', workspaceId: 'ws1', workspaceName: 'UAT', dataSourceId: 'ds1' },
    ] })
    getViewMock.mockImplementation(async (id: string) => ({ id, access: { canEdit: id === 'view_rw' } }))
    renderImport()

    fireEvent.click(await screen.findByText('Overwrite an existing view…'))
    fireEvent.click(await screen.findByText('Read-only view'))
    expect(await screen.findByText(/You can’t edit this view, so it can’t be overwritten/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Editable view'))
    expect(await screen.findByText(/Overwriting/)).toHaveTextContent('Overwriting Editable view in UAT')
    expect(getViewMock.mock.calls.map(([id]) => id)).toEqual(['view_ro', 'view_rw'])
  })
  it('looks again at entities whose lookup failed', async () => {
    inspectMock.mockResolvedValue(inspected())
    const failed = reconciled()
    const summary = failed.views[0].report.summary
    summary.entities = { ...summary.entities, unknown: 1, checked: 1 }
    reconcileMock.mockResolvedValueOnce(failed).mockResolvedValue(reconciled())
    renderImport()
    await screen.findByText('Create a new view')
    await next()                                          // → Target
    await next()                                          // → Match

    expect(await screen.findByText(/1 entity couldn’t be checked because the lookup failed/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Check again/ }))
    await waitFor(() => expect(reconcileMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Check again/ })).not.toBeInTheDocument())
  })
})

// ── A file of several views ────────────────────────────────────────────────

/** Two views from dev: "Finance lineage" is new here; "Sales pipeline" is already here as "Sales (UAT)". */
function inspectedPair(): InspectResult {
  const one = inspected({
    pv_2: [{ viewId: 'view_uat', name: 'Sales (UAT)', workspaceId: 'ws1', workspaceName: 'UAT', dataSourceId: 'ds1', headVersion: 3, canEdit: true, status: 'fast_forward' }],
  })
  const finance = one.views[0]
  return {
    ...one,
    views: [
      finance,
      { ...finance, index: 1, portableId: 'pv_2', sourceViewId: 'view_dev_2', metadata: { ...finance.metadata, name: 'Sales pipeline' } },
    ],
  }
}

/** Every view asked about comes back half-matched; an update also says how it relates. */
function reconcileEach() {
  reconcileMock.mockImplementation(async (views: Array<{ key: string; action: string }>) => ({
    views: views.map(v => ({ ...reconciled().views[0], key: v.key, update: v.action === 'update' ? FAST_FORWARD : null })),
    aggregate: reconciled().aggregate,
  }))
}

async function throughToReview() {
  expect(await screen.findByText('2 views from dev')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'All 2 views' })).toHaveAttribute('aria-pressed', 'true')
  await next()                                            // → Targets
  expect(await screen.findByText('Where should these views go?')).toBeInTheDocument()
  expect(screen.getByLabelText('Where views from Lineage go')).toHaveValue('ws1|ds1')
  await next()                                            // → Match
  expect(await screen.findByText('How they fit here')).toBeInTheDocument()
}

describe('ViewWizard — importing every view of a file', () => {
  beforeEach(() => {
    inspectMock.mockResolvedValue(inspectedPair())
    getViewMock.mockResolvedValue({
      id: 'view_uat', name: 'Sales (UAT)', description: 'Pipeline, as UAT has it', workspaceId: 'ws1', dataSourceId: 'ds1',
      viewType: 'reference', config: { icon: 'Workflow' }, tags: ['uat'], visibility: 'workspace',
    })
    reconcileEach()
  })

  it('checks them all at once, then imports each under one batch', async () => {
    importMock.mockImplementation(async (req: { target: { viewId?: string } }) => imported(req.target.viewId ?? 'view_new'))
    renderImport()
    await throughToReview()

    expect(reconcileMock).toHaveBeenCalledTimes(1)
    expect(reconcileMock).toHaveBeenCalledWith([
      expect.objectContaining({ key: '0', action: 'create', target: { workspaceId: 'ws1', dataSourceId: 'ds1' } }),
      expect.objectContaining({ key: '1', action: 'update', target: { viewId: 'view_uat' } }),
    ])
    await next()                                          // → Review
    expect(await screen.findByLabelText('Name for Finance lineage')).toHaveValue('Finance lineage')
    expect(screen.getByLabelText('Name for Sales pipeline')).toHaveValue('Sales (UAT)')
    fireEvent.click(await screen.findByRole('button', { name: /Import 2 views/ }))

    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(2))
    const [[created], [updated]] = importMock.mock.calls
    expect(created).toMatchObject({
      action: 'create', target: { workspaceId: 'ws1', dataSourceId: 'ds1' },
      metadata: { name: 'Finance lineage', description: 'What feeds revenue', visibility: 'private' },
      origin: { portableId: 'pv_1', environment: 'dev' },
    })
    // An update keeps the view's own description, icon and tags, and is checked against the design reviewed.
    expect(updated).toMatchObject({
      action: 'update', target: { viewId: 'view_uat' }, expectedTargetHash: 'sha256:old',
      metadata: { name: 'Sales (UAT)', description: 'Pipeline, as UAT has it', icon: 'Workflow', tags: ['uat'] },
      origin: { portableId: 'pv_2' },
    })
    expect(updated.metadata.visibility).toBeUndefined()
    expect(created.batchId).toBe(updated.batchId)
    expect(created.requestId).not.toBe(updated.requestId)
    expect(await screen.findAllByText(/integrity verified/)).toHaveLength(2)
  })

  it('carries on past a failure, and retries it under the same request id', async () => {
    importMock
      .mockRejectedValueOnce(new Error('The data source is offline'))
      .mockImplementation(async () => imported('view_x'))
    renderImport()
    await throughToReview()
    await next()
    fireEvent.click(await screen.findByRole('button', { name: /Import 2 views/ }))

    expect(await screen.findByText('The data source is offline')).toBeInTheDocument()
    expect(importMock).toHaveBeenCalledTimes(2)           // the second view went ahead
    fireEvent.click(screen.getByRole('button', { name: /Retry 1 failed import/ }))

    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(3))
    const retried = importMock.mock.calls[2][0]
    expect(retried.origin.portableId).toBe('pv_1')
    expect(retried.requestId).toBe(importMock.mock.calls[0][0].requestId)
    await waitFor(() => expect(screen.queryByText('The data source is offline')).not.toBeInTheDocument())
  })

  it('checks again a view switched to a separate copy, and leaves out a skipped one', async () => {
    importMock.mockImplementation(async () => imported('view_copy'))
    renderImport()
    await throughToReview()

    fireEvent.change(screen.getByLabelText('What to do with Sales pipeline'), { target: { value: 'copy' } })
    await waitFor(() => expect(reconcileMock).toHaveBeenCalledTimes(2))
    expect(reconcileMock.mock.calls[1][0]).toEqual([
      expect.objectContaining({ key: '1', action: 'copy', target: { workspaceId: 'ws1', dataSourceId: 'ds1' } }),
    ])
    fireEvent.change(screen.getByLabelText('What to do with Finance lineage'), { target: { value: 'skip' } })
    await next()                                          // → Review
    // A copy is a new view: it takes the file's name, and a visibility.
    expect(await screen.findByLabelText('Name for Sales pipeline')).toHaveValue('Sales pipeline')
    expect(screen.queryByLabelText('Name for Finance lineage')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: /Import 1 view/ }))

    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(1))
    expect(importMock.mock.calls[0][0]).toMatchObject({
      action: 'copy', target: { workspaceId: 'ws1', dataSourceId: 'ds1' },
      metadata: { name: 'Sales pipeline', visibility: 'private' }, expectedTargetHash: null,
    })
  })
  it('checks again a view that changed here during the import, before importing it again', async () => {
    importMock
      .mockImplementationOnce(async () => imported('view_new'))
      .mockRejectedValueOnce(new ViewTransferError('“Sales (UAT)” changed after you reviewed it.', 409, 'target_changed'))
      .mockImplementation(async () => imported('view_uat'))
    renderImport()
    await throughToReview()
    await next()
    fireEvent.click(await screen.findByRole('button', { name: /Import 2 views/ }))

    // Retrying with the old check would only be refused again.
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument()
    reconcileMock.mockImplementation(async (views: Array<{ key: string }>) => ({
      views: views.map(v => ({ ...reconciled().views[0], key: v.key, update: { ...FAST_FORWARD, targetWorkingHash: 'sha256:new' } })),
      aggregate: reconciled().aggregate,
    }))
    fireEvent.click(await screen.findByRole('button', { name: 'Check the changed views again' }))
    expect(await screen.findByText('How they fit here')).toBeInTheDocument()
    await waitFor(() => expect(reconcileMock).toHaveBeenCalledTimes(2))
    expect(reconcileMock.mock.calls[1][0]).toEqual([expect.objectContaining({ key: '1', action: 'update' })])
    await next()                                          // → Review
    fireEvent.click(await screen.findByRole('button', { name: /Import 1 view/ }))

    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(3))
    expect(importMock.mock.calls[2][0]).toMatchObject({
      target: { viewId: 'view_uat' }, expectedTargetHash: 'sha256:new', requestId: importMock.mock.calls[1][0].requestId,
    })
  })

  it('says which view to update can’t be read here, rather than leaving Import dead', async () => {
    getViewMock.mockRejectedValue(new Error('View not found'))
    renderImport()
    await throughToReview()
    await next()                                          // → Review

    expect(await screen.findByText(/“Sales \(UAT\)” can’t be read here any more/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Import 2 views/ })).toBeDisabled()
  })
  it('looks again at the views with entities whose lookup failed', async () => {
    reconcileMock.mockImplementationOnce(async (views: Array<{ key: string; action: string }>) => ({
      views: views.map(v => {
        const r = { ...reconciled().views[0], key: v.key, update: v.action === 'update' ? FAST_FORWARD : null }
        if (v.key === '1') r.report.summary.entities = { ...r.report.summary.entities, unknown: 1 }
        return r
      }),
      aggregate: reconciled().aggregate,
    }))
    renderImport()
    await throughToReview()

    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(reconcileMock).toHaveBeenCalledTimes(2))
    expect(reconcileMock.mock.calls[1][0]).toEqual([expect.objectContaining({ key: '1', action: 'update' })])
  })
})

// ── Into a draft ─────────────────────────────────────────────────────────────

async function throughToPreview() {
  await screen.findByText('Create a new view')
  await next()                                            // → Target
  await next()                                            // → Match
  await screen.findByText('How it fits here')
  for (const step of ['basics-step', 'layout-step', 'assignment-step', 'entities-step', 'preview-step']) {
    await next()
    await screen.findByTestId(step)
  }
}

describe('ViewWizard — importing into a draft', () => {
  beforeEach(() => {
    staging = { versioned: true, allowed: true, checking: false, graphId: 'g1' }
    inspectMock.mockResolvedValue(inspected())
    reconcileMock.mockResolvedValue(reconciled())
  })

  it('waits in a draft by default on a version-controlled data source, and opens there', async () => {
    importMock.mockResolvedValue({ ...imported('view_new'), staged: { branchId: 'br_9' } })
    renderImport()
    await throughToPreview()

    expect(screen.getByText('When it goes live')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /In a draft, after review/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: /Import View/ }))

    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(1))
    expect(importMock.mock.calls[0][0]).toMatchObject({ action: 'create', stage: true })
    expect(await screen.findByText('Waiting in a draft')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Open view now/ }))
    expect(screen.getByTestId('location')).toHaveTextContent('/views/view_new?branch=br_9')
  })

  it('goes live at once when that is chosen', async () => {
    importMock.mockResolvedValue(imported('view_new'))
    renderImport()
    await throughToPreview()

    fireEvent.click(screen.getByRole('radio', { name: /Now/ }))
    fireEvent.click(screen.getByRole('button', { name: /Import View/ }))
    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(1))
    expect(importMock.mock.calls[0][0].stage).toBeUndefined()
  })

  it('offers no draft without the right to open one', async () => {
    staging = { versioned: true, allowed: false, checking: false }
    importMock.mockResolvedValue(imported('view_new'))
    renderImport()
    await throughToPreview()

    expect(screen.getByRole('radio', { name: /In a draft, after review/ })).toBeDisabled()
    expect(screen.getByText(/needs permission to manage it/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Import View/ }))
    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(1))
    expect(importMock.mock.calls[0][0].stage).toBeUndefined()
  })

  it('stages every view of a file in drafts, each opened on its own', async () => {
    inspectMock.mockResolvedValue(inspectedPair())
    getViewMock.mockResolvedValue({
      id: 'view_uat', name: 'Sales (UAT)', description: 'Pipeline, as UAT has it', workspaceId: 'ws1', dataSourceId: 'ds1',
      viewType: 'reference', config: { icon: 'Workflow' }, tags: ['uat'], visibility: 'workspace',
    })
    reconcileEach()
    importMock.mockImplementation(async (req: { target: { viewId?: string } }) => ({
      ...imported(req.target.viewId ?? 'view_new'), staged: { branchId: `br_${req.target.viewId ?? 'new'}` },
    }))
    renderImport()
    await throughToReview()
    await next()                                          // → Review
    expect(await screen.findByText('When they go live')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: /Import 2 views/ }))

    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(2))
    expect(importMock.mock.calls.map(([r]) => r.stage)).toEqual([true, true])
    expect(await screen.findAllByRole('button', { name: 'Open in draft' })).toHaveLength(2)
  })

  it('submits the draft for review from where it landed, and opens the view live once published', async () => {
    importMock.mockResolvedValue({ ...imported('view_new'), staged: { branchId: 'br_9' } })
    renderImport()
    await throughToPreview()
    fireEvent.click(screen.getByRole('button', { name: /Import View/ }))

    fireEvent.click(await screen.findByRole('button', { name: /Submit for review/ }))
    expect(screen.getByTestId('publish-draft')).toHaveTextContent('ws1/g1/br_9')
    // It doesn't open the view under the dialog: the countdown stops.
    expect(screen.getByText(/Open it whenever you’re ready/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Publish (stub)' }))
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/views\/view_new$/)
  })

  it('offers no review without the right to open one', async () => {
    staging = { ...staging, allowed: false }
    importMock.mockResolvedValue({ ...imported('view_new'), staged: { branchId: 'br_9' } })
    renderImport()
    await throughToPreview()
    fireEvent.click(screen.getByRole('button', { name: /Import View/ }))
    expect(await screen.findByText('Waiting in a draft')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Submit for review/ })).not.toBeInTheDocument()
  })

  it('submits every view of a file for review, one review per view’s draft', async () => {
    inspectMock.mockResolvedValue(inspectedPair())
    getViewMock.mockResolvedValue({
      id: 'view_uat', name: 'Sales (UAT)', description: 'Pipeline, as UAT has it', workspaceId: 'ws1', dataSourceId: 'ds1',
      viewType: 'reference', config: { icon: 'Workflow' }, tags: ['uat'], visibility: 'workspace',
    })
    reconcileEach()
    importMock.mockImplementation(async (req: { target: { viewId?: string } }) => ({
      ...imported(req.target.viewId ?? 'view_new'), staged: { branchId: `br_${req.target.viewId ?? 'new'}` },
    }))
    // The second is already in review (another tab): that review is the one.
    openReviewMock
      .mockResolvedValueOnce({ prId: 'pr_1' })
      .mockRejectedValueOnce(new PullRequestExistsError({ prId: 'pr_2', branchId: 'br_new' }))
    renderImport()
    await throughToReview()
    await next()
    fireEvent.click(await screen.findByRole('button', { name: /Import 2 views/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Submit 2 drafts for review/ }))

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Open review' })).toHaveLength(2))
    expect(openReviewMock.mock.calls.map(([ws, graph, branch]) => `${ws}/${graph}/${branch}`).sort())
      .toEqual(['ws1/g1/br_new', 'ws1/g1/br_view_uat'])
    expect(openReviewMock.mock.calls[0][3].title).toMatch(/^Import “/)
    expect(screen.queryByRole('button', { name: /for review/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Open review' })[0])
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/workspaces\/ws1\/reviews\?pr=pr_/)
  })
})

// ── A view with its data ────────────────────────────────────────────────────

const VERSIONED = { versioned: true, allowed: true, checking: false }

/** A package of "Finance lineage" with the data of its entities, suggested for UAT's Lineage (and,
 *  next best, UAT's Archive). */
function inspectedPackage(): PackageInspectResult {
  const base = inspected()
  const suggestion = base.targetSuggestions.s1[0]
  return {
    ...base,
    uploadId: 'up_1',
    package: {
      scope: 'view', data: { version: 'published', nodes: 120, edges: 80 }, createdAt: '2026-09-20T10:00:00Z',
      parts: {
        'view-bundle.json': { sha256: 'sha256:b', bytes: 2048, verified: true },
        'data/graph.ndjson': { sha256: 'sha256:d', bytes: 40960, verified: true },
      },
      integrity: 'verified',
    },
    targetSuggestions: {
      s1: [
        { ...suggestion, versioned: true },
        { ...suggestion, dataSourceId: 'ds2', label: 'Archive', score: 40, sampleHitRate: 0.1, versioned: true },
      ],
    },
  }
}

const DATA_STARTED = {
  jobId: 'imp_1', branchId: 'br_data', graphId: 'g1', workspaceId: 'ws1', dataSourceId: 'ds1', viewId: null,
  draftName: 'Import: Finance lineage',
}

function renderPackage() {
  const file = new File(['PK'], 'finance.v7.view-package.zip', { type: 'application/zip' })
  return renderImport({ importFile: file })
}

describe('ViewWizard — a view with its data', () => {
  beforeEach(() => {
    staging = VERSIONED
    inspectPackageMock.mockResolvedValue(inspectedPackage())
    reconcileMock.mockResolvedValue(reconciled())
    packageDataMock.mockResolvedValue(DATA_STARTED)
    getImportMock.mockResolvedValue({ jobId: 'imp_1', jobType: 'ingest', status: 'completed', graphId: 'g1', branchId: 'br_data' })
    importPreviewMock.mockResolvedValue({
      job: { jobId: 'imp_1', jobType: 'ingest', status: 'completed', graphId: 'g1' },
      summary: { new: 118, updated: 2, unchanged: 0, deleted: 0, invalid: 0 },
      sample: [{ rowIndex: 0, kind: 'node', status: 'new', label: 'revenue' }],
    })
  })

  it('tries a failed data import again, into the same draft', async () => {
    packageDataMock
      .mockResolvedValueOnce(DATA_STARTED)
      .mockResolvedValueOnce({ ...DATA_STARTED, jobId: 'imp_2', attempt: 2 })
    getImportMock
      .mockResolvedValueOnce({ jobId: 'imp_1', jobType: 'ingest', status: 'failed', graphId: 'g1', errorMessage: 'The graph was busy' })
      .mockResolvedValue({ jobId: 'imp_2', jobType: 'ingest', status: 'completed', graphId: 'g1', branchId: 'br_data' })
    renderPackage()
    await screen.findByText('Import a view with its data')
    await next()                                          // → Target
    await next()                                          // → Data
    fireEvent.click(await screen.findByRole('button', { name: /Bring the data into a draft/ }))

    expect(await screen.findByText('The graph was busy')).toBeInTheDocument()
    expect(screen.getByText(/It runs again into the same draft, “Import: Finance lineage”/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))

    expect(await screen.findByText('The data is in the draft')).toBeInTheDocument()
    expect(packageDataMock).toHaveBeenCalledTimes(2)
    expect(packageDataMock.mock.calls[1]).toEqual(packageDataMock.mock.calls[0])
  })

  it('brings the data into a draft, checks the view against it, and puts the view there too', async () => {
    importMock.mockResolvedValue({ ...imported('view_new'), version: null, staged: { branchId: 'br_data' } })
    renderPackage()

    expect(await screen.findByText('Import a view with its data')).toBeInTheDocument()
    expect(screen.getByText(/120 entities and 80 relationships/)).toBeInTheDocument()
    expect(inspectMock).not.toHaveBeenCalled()
    await next()                                          // → Target
    expect(await screen.findAllByText('Version control')).toHaveLength(2)
    await next()                                          // → Data
    expect(await screen.findByText('Bring in the data')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Bring the data into a draft/ }))

    expect(await screen.findByText('The data is in the draft')).toBeInTheDocument()
    expect(packageDataMock).toHaveBeenCalledWith('up_1', {
      workspaceId: 'ws1', dataSourceId: 'ds1', viewId: null, draftName: 'Import: Finance lineage',
    })
    expect(screen.getByText('118')).toBeInTheDocument()
    await next()                                          // → Match, against the draft
    expect(await screen.findByText('How it fits here')).toBeInTheDocument()
    expect(reconcileMock).toHaveBeenCalledWith([expect.objectContaining({
      action: 'create', target: { workspaceId: 'ws1', dataSourceId: 'ds1', branchId: 'br_data' },
    })])

    for (const step of ['basics-step', 'layout-step', 'assignment-step', 'entities-step', 'preview-step']) {
      await next()
      await screen.findByTestId(step)
    }
    expect(screen.getByText('It joins its data in “Import: Finance lineage”')).toBeInTheDocument()
    expect(screen.queryByText('When it goes live')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Import View/ }))

    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(1))
    expect(importMock.mock.calls[0][0]).toMatchObject({
      action: 'create', stage: true, target: { workspaceId: 'ws1', dataSourceId: 'ds1', branchId: 'br_data' },
    })
    expect(await screen.findByText('Waiting with its data in “Import: Finance lineage”')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Open view now/ }))
    expect(screen.getByTestId('location')).toHaveTextContent('/views/view_new?branch=br_data')
  })

  it('goes only where the data can, and imports the view alone when asked', async () => {
    staging = NOT_VERSIONED
    importMock.mockResolvedValue(imported('view_new'))
    renderPackage()

    await screen.findByText('Import a view with its data')
    await next()                                          // → Target
    expect(await screen.findByText(/isn’t under version control, so the package’s data can’t go into it/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(await screen.findByRole('radio', { name: 'View only' }))
    expect(screen.getByRole('heading', { name: 'Import a view' })).toBeInTheDocument()
    await next()                                          // → Target
    await next()                                          // → Match: no Data step, against what's published
    expect(await screen.findByText('How it fits here')).toBeInTheDocument()
    expect(reconcileMock).toHaveBeenCalledWith([expect.objectContaining({ target: { workspaceId: 'ws1', dataSourceId: 'ds1' } })])
    expect(packageDataMock).not.toHaveBeenCalled()
  })

  it('asks for the file again once the data went into a draft elsewhere', async () => {
    renderPackage()
    await screen.findByText('Import a view with its data')
    await next()
    await next()
    fireEvent.click(await screen.findByRole('button', { name: /Bring the data into a draft/ }))
    await screen.findByText('The data is in the draft')

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))                 // → Target
    fireEvent.click(await screen.findByRole('button', { name: /Archive/ }))
    await next()                                                                    // → Data, for Archive
    expect(await screen.findByText('The data already went into another draft')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Choose the file again/ }))
    expect(await screen.findByText('Drop a view file here')).toBeInTheDocument()
    expect(packageDataMock).toHaveBeenCalledTimes(1)
  })
})
