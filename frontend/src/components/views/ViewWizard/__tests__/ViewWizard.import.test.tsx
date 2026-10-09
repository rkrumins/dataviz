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
 *   - the Match step says when the ontology here isn't the one the view was exported with;
 *   - a file of several views: every view checked in one request, then imported one request per
 *     view under one batch id; an update keeps the view's own details; a failure doesn't stop the
 *     rest and is retried under the same request id; a view switched to a copy is checked again, as
 *     is one that changed here during the import; a view to update that can't be read says so; a
 *     type missing here is mapped once for every view from its source; a view can overwrite one
 *     picked here, keeping that view's details;
 *   - on a version-controlled data source, an import waits in a draft by default (or goes live,
 *     if chosen), and the view then opens on that draft; the draft can be submitted for review
 *     from there (the view opens live once it's published), and a file's views all at once,
 *     one review per view's draft;
 *   - a view with its data (a package): while it is read, it says how much of it is up, then that
 *     it is checked; its data goes into a new draft of a version-controlled target (saying how many
 *     rows it read, and applied), the view is checked against that draft and goes into it too, and
 *     opens there; a target that can't take the data is refused (the view alone still can be
 *     imported); another target takes the same upload into a draft of its own, with no file to
 *     choose again; an upload that expired asks for the file again; a data import that failed can
 *     be tried again, into the same draft;
 *   - or its data goes into a brand-new data source of its own: described on the Target step (its
 *     label and graph name from the package, a connection, the semantic layer matched for it, or
 *     one created from the package), created by one request that a reopened wizard follows again
 *     rather than repeating, and copied in full; then its view comes in live, or every view of
 *     the package through the batch flow, preset to it; an expired upload asks for the file again.
 */
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ImportViewResult, InspectResult, PackageInspectResult, PackageProgress, ReconcileResult,
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
const newSourceMock = vi.fn()
const bootstrapStatusMock = vi.fn()
const nameCheckMock = vi.fn()
const suggestMock = vi.fn()
const createLayerMock = vi.fn()
const getPackageMock = vi.fn()
const getUploadMock = vi.fn()
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
    createNewSourceFromPackage: (...args: unknown[]) => newSourceMock(...args),
    getViewPackage: (...args: unknown[]) => getPackageMock(...args),
    getPackageUpload: (...args: unknown[]) => getUploadMock(...args),
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
  return {
    ...actual,
    openMergeRequest: (...args: unknown[]) => openReviewMock(...args),
    getBootstrapStatus: (...args: unknown[]) => bootstrapStatusMock(...args),
    checkBlankGraphName: (...args: unknown[]) => nameCheckMock(...args),
  }
})
vi.mock('@/services/ontologyDefinitionService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ontologyDefinitionService')>()
  return {
    ...actual,
    ontologyDefinitionService: { ...actual.ontologyDefinitionService, suggest: (...a: unknown[]) => suggestMock(...a) },
  }
})
vi.mock('@/features/ontology/hooks/useOntologies', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/ontology/hooks/useOntologies')>()),
  useOntologies: () => ({
    data: [
      { id: 'onto_fin', name: 'Finance (shared)', version: 2, isPublished: true, entityTypeDefinitions: {}, relationshipTypeDefinitions: {} },
      { id: 'onto_ops', name: 'Operations', version: 1, isPublished: true, entityTypeDefinitions: {}, relationshipTypeDefinitions: {} },
    ],
  }),
}))
vi.mock('@/features/ontology/hooks/useOntologyMutations', () => ({
  useOntologyMutations: () => ({ create: { mutateAsync: (...a: unknown[]) => createLayerMock(...a), isPending: false } }),
}))
// The graph connections a new data source can go on (the blank-model picker's own).
vi.mock('../useBlankScopeOptions', () => ({
  useBlankScopeOptions: () => ({
    providers: [{ provider: { id: 'p1', name: 'Falkor prod', providerType: 'falkordb' }, graphCount: 1, inUseCount: 0, blankSupported: true }],
    ontologies: [], isLoading: false, isError: false,
  }),
}))
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
// Jobs are followed with pollJob; its waits shortened so the tests don't sit them out.
vi.mock('@/config/polling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/polling')>()),
  jobPollDelayMs: () => 1,
}))
const reloadLibraryMock = vi.fn()
vi.mock('@/store/viewLibraryStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/store/viewLibraryStore')>()),
  reloadViewLibrary: (...args: unknown[]) => reloadLibraryMock(...args),
}))
// Steps swap at once. Under framer-motion's AnimatePresence, an import that answers in the same
// render the previous step finishes leaving mounts its progress already leaving, and framer-motion 11
// never plays an exit for a child that mounts absent: the step then never changes (Node 20, as in CI).
vi.mock('framer-motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('framer-motion')>()),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
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
    ScopeStep: ({ aboveSlot, scopeMode, providers, onSelectProvider, blankOntologySlot }: {
      aboveSlot?: React.ReactNode
      scopeMode: string
      providers: Array<{ provider: { id: string; name: string } }>
      onSelectProvider: (id: string) => void
      blankOntologySlot?: React.ReactNode
    }) => (
      <div data-testid="scope-step">
        {aboveSlot}
        {scopeMode === 'blank' && providers.map(o => (
          <button key={o.provider.id} type="button" onClick={() => onSelectProvider(o.provider.id)}>{o.provider.name}</button>
        ))}
        {blankOntologySlot}
      </div>
    ),
  }
})

import { ViewTransferError } from '@/services/viewTransferApiService'
import { PullRequestExistsError, type BootstrapJob } from '@/services/versioningApiService'
import { useSchemaStore } from '@/store/schema'
import { useWorkspacesStore } from '@/store/workspaces'
import { useAuthStore } from '@/store/auth'
import { recordEvent } from '@/services/telemetryService'
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
    // Its design is the file's now, display rules and all: a canvas that has it open reads them again.
    await waitFor(() => expect(reloadLibraryMock).toHaveBeenCalledWith('view_uat'))
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
  it('says when the ontology here isn’t the one the view was built with', async () => {
    const before = useSchemaStore.getState().schema
    useSchemaStore.setState({ schema: {
      id: 'uat', name: 'UAT', version: '1', entityTypes: [], relationshipTypes: [], views: [], defaultViewId: '',
      globalVisuals: {}, ontologyDigest: 'digest-uat',
    } as unknown as typeof before })
    try {
      const file = inspected()
      file.bundle.sources.s1.ontology = { digest: 'digest-dev' }
      inspectMock.mockResolvedValue(file)
      reconcileMock.mockResolvedValue(reconciled())
      renderImport()
      await screen.findByText('Create a new view')
      await next()                                          // → Target
      await next()                                          // → Match
      expect(await screen.findByText(/The ontology here isn’t the one this view was built with in dev/)).toBeInTheDocument()
    } finally {
      useSchemaStore.setState({ schema: before })
    }
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
    // Each view's design is the file's now: a canvas that has one open reads its rules again.
    expect(reloadLibraryMock).toHaveBeenCalledWith('view_uat')
    expect(reloadLibraryMock).toHaveBeenCalledWith('view_new')
  })

  it('maps a type that isn’t here once, for every view from that source', async () => {
    const withMissingType = () => {
      const r = reconciled().views[0]
      return {
        ...r,
        report: {
          ...r.report,
          types: { entity: [...r.report.types.entity, { id: 'Table', status: 'missing' as const, suggestions: ['table'], layers: ['Sources'] }], relationship: [] },
          availableTypes: { entity: [{ id: 'dataset', name: 'Dataset' }, { id: 'table', name: 'Table' }], relationship: [] },
        },
      }
    }
    reconcileMock.mockImplementation(async (views: Array<{ key: string; action: string }>) => ({
      views: views.map(v => ({ ...withMissingType(), key: v.key, update: v.action === 'update' ? FAST_FORWARD : null })),
      aggregate: reconciled().aggregate,
    }))
    renderImport()
    await throughToReview()

    expect(await screen.findByText('Types that don’t exist here')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Map Table'), { target: { value: 'table' } })
    fireEvent.click(screen.getByRole('button', { name: /Re-check with these choices/ }))
    await waitFor(() => expect(reconcileMock).toHaveBeenCalledTimes(2))
    expect(reconcileMock.mock.calls[1][0].map((v: { resolutions: { typeMap?: object } }) => v.resolutions.typeMap))
      .toEqual([{ Table: 'table' }, { Table: 'table' }])
  })

  it('overwrites a view picked here instead of creating one, keeping that view’s details', async () => {
    listViewsMock.mockResolvedValue({ items: [
      { id: 'view_hand', name: 'Finance (built by hand)', workspaceId: 'ws1', workspaceName: 'UAT', dataSourceId: 'ds1', viewType: 'reference' },
    ] })
    getViewMock.mockImplementation(async (id: string) => id === 'view_hand'
      ? { id, name: 'Finance (built by hand)', description: 'Rebuilt in UAT', workspaceId: 'ws1', dataSourceId: 'ds1',
        viewType: 'reference', config: { icon: 'Layout' }, tags: [], visibility: 'workspace', access: { canEdit: true } }
      : { id, name: 'Sales (UAT)', description: 'Pipeline, as UAT has it', workspaceId: 'ws1', dataSourceId: 'ds1',
        viewType: 'reference', config: { icon: 'Workflow' }, tags: ['uat'], visibility: 'workspace' })
    importMock.mockImplementation(async (req: { target: { viewId?: string } }) => imported(req.target.viewId ?? 'view_new'))
    renderImport()
    await throughToReview()

    fireEvent.change(screen.getByLabelText('What to do with Finance lineage'), { target: { value: 'overwrite' } })
    fireEvent.click(await screen.findByText('Finance (built by hand)'))
    await waitFor(() => expect(reconcileMock).toHaveBeenLastCalledWith([
      expect.objectContaining({ key: '0', action: 'overwrite', target: { viewId: 'view_hand' } }),
    ]))
    expect(screen.getByText(/Overwrites “Finance \(built by hand\)”/)).toBeInTheDocument()

    await next()                                          // → Review
    fireEvent.click(await screen.findByRole('button', { name: /Import 2 views/ }))
    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(2))
    const overwrite = importMock.mock.calls.map(([r]) => r).find(r => r.action === 'overwrite')
    expect(overwrite).toMatchObject({
      target: { viewId: 'view_hand' },
      metadata: { name: 'Finance (built by hand)', description: 'Rebuilt in UAT', icon: 'Layout' },
    })
    expect(overwrite.metadata.visibility).toBeUndefined()
    // One event per view, as a single import records it, and never a name.
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith('view.import',
      { action: 'overwrite', strategy: 'replace', staged: false, match: '50-80', batch: true })
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

  it('says how much of the package is up, then that it is checked', async () => {
    let progress: ((p: PackageProgress) => void) | undefined
    inspectPackageMock.mockImplementation((_file: File, opts?: { onProgress?: (p: PackageProgress) => void }) => {
      progress = opts?.onProgress
      return new Promise(() => {})                       // still reading
    })
    renderPackage()
    await waitFor(() => expect(progress).toBeDefined())

    act(() => progress!({ stage: 'upload', sent: 5 * 1024 ** 2, total: 20 * 1024 ** 2 }))
    expect(await screen.findByText('Uploading… 25% of 20.0 MB')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
    act(() => progress!({ stage: 'check', progress: null }))
    expect(await screen.findByText('Checking the package…')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('says how many rows the data import read, and how many it applied', async () => {
    let finished = false
    getImportMock.mockImplementation(async () => (finished
      ? { jobId: 'imp_1', jobType: 'ingest', status: 'completed', graphId: 'g1', branchId: 'br_data' }
      : { jobId: 'imp_1', jobType: 'ingest', status: 'running', graphId: 'g1', phase: 'nodes', processed: 4000, total: 12000 }))
    renderPackage()
    await screen.findByText('Import a view with its data')
    await next()                                          // → Target
    await next()                                          // → Data
    fireEvent.click(await screen.findByRole('button', { name: /Bring the data into a draft/ }))

    expect(await screen.findByText('Read 12,000 rows · applied 4,000 of 12,000')).toBeInTheDocument()
    finished = true
    expect(await screen.findByText('The data is in the draft')).toBeInTheDocument()
  })

  it('brings the data into another target’s own draft too, with no file to choose again', async () => {
    renderPackage()
    await screen.findByText('Import a view with its data')
    await next()
    await next()
    fireEvent.click(await screen.findByRole('button', { name: /Bring the data into a draft/ }))
    await screen.findByText('The data is in the draft')

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))                 // → Target
    fireEvent.click(await screen.findByRole('button', { name: /Archive/ }))
    await next()                                                                    // → Data, for Archive
    expect(await screen.findByText(/It already went into “Import: Finance lineage”, where you chose before/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Choose the file again/ })).not.toBeInTheDocument()
    packageDataMock.mockResolvedValueOnce({ ...DATA_STARTED, jobId: 'imp_2', branchId: 'br_archive', dataSourceId: 'ds2' })
    fireEvent.click(screen.getByRole('button', { name: /Bring the data into a draft/ }))

    expect(await screen.findByText('The data is in the draft')).toBeInTheDocument()
    expect(packageDataMock).toHaveBeenCalledTimes(2)
    expect(packageDataMock.mock.calls[1]).toEqual(['up_1', expect.objectContaining({ workspaceId: 'ws1', dataSourceId: 'ds2' })])
  })

  it('asks for the file again once its upload has expired', async () => {
    packageDataMock.mockRejectedValue(new ViewTransferError(
      'This package upload is about to expire. Choose the file again to import it.', 410, 'upload_expired'))
    renderPackage()
    await screen.findByText('Import a view with its data')
    await next()
    await next()
    fireEvent.click(await screen.findByRole('button', { name: /Bring the data into a draft/ }))

    expect(await screen.findByText('The package’s upload has expired')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Try again/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Choose the file again/ }))
    expect(await screen.findByText('Drop a view file here')).toBeInTheDocument()
  })

  it('does not take any 404 for an expired upload', async () => {
    packageDataMock.mockRejectedValue(new ViewTransferError("Workspace 'ws1' not found", 404))
    renderPackage()
    await screen.findByText('Import a view with its data')
    await next()
    await next()
    fireEvent.click(await screen.findByRole('button', { name: /Bring the data into a draft/ }))

    expect(await screen.findByText("Workspace 'ws1' not found")).toBeInTheDocument()
    expect(screen.queryByText('The package’s upload has expired')).not.toBeInTheDocument()
  })
})

// ── A package's data in a new data source of its own ──────────────────────────────────────────

const TYPE_STATS = { nodeCount: 120, edgeCount: 80, entityTypeCounts: { dataset: 100, job: 20 }, edgeTypeCounts: { PRODUCES: 80 } }
const SUGGESTED = { name: 'Suggested', entityTypeDefinitions: { dataset: {}, job: {} }, relationshipTypeDefinitions: { PRODUCES: {} } }

function score(ontologyId: string, jaccardScore: number) {
  return {
    ontologyId, ontologyName: ontologyId, version: 1, jaccardScore,
    coveredEntityTypes: ['dataset'], uncoveredEntityTypes: ['job'], coveredRelationshipTypes: ['PRODUCES'],
    uncoveredRelationshipTypes: [], totalEntityTypes: 2, totalRelationshipTypes: 1,
  }
}

/** The package, as the server describes it with what its data holds by type. */
function packageWithStats(over: Partial<PackageInspectResult> = {}): PackageInspectResult {
  const p = inspectedPackage()
  return { ...p, package: { ...p.package, data: { ...p.package.data!, typeStats: TYPE_STATS } }, ...over }
}

const STARTED = {
  dataSourceId: 'ds_new', graphId: 'g_new', jobId: 'vjob_9', status: 'pending', label: 'Lineage',
  graphName: 'lineage_copy', ontologyId: 'onto_fin', enforcement: 'permissive', requestId: 'nsr_x',
}
const SEED_RUNNING: BootstrapJob = {
  jobId: 'vjob_9', graphId: 'g_new', status: 'running', phase: 'nodes', processed: 40, total: 200, percent: 20,
  origin: 'package',
}
const SEED_DONE: BootstrapJob = {
  ...SEED_RUNNING, status: 'completed', phase: null, processed: 200, percent: 100,
  report: {
    checks: [{ key: 'parsed_matches_manifest', ok: true, detail: '200 of 200 rows copied', blocking: true }],
    source: { nodes: 120, edges: 80 }, stored: { nodes: 120, edges: 80 }, labels: {}, edgeTypes: {},
    sampleChecked: 10, sampleMismatched: [], mergedDuplicateConnections: 0, merkle: 'inline',
  },
}

/** The package file: the same file chosen again is known again (name, size, modification time). */
function renderNewSource() {
  const file = new File(['PK'], 'finance.v7.view-package.zip', { type: 'application/zip', lastModified: 1_700_000_000_000 })
  return renderImport({ importFile: file })
}

/** File → Target, its data into a new data source on the one connection there is. */
async function toNewSourceTarget() {
  await screen.findByText('Import a view with its data')
  await next()                                            // → Target
  fireEvent.click(await screen.findByRole('radio', { name: 'Into a new data source' }))
  fireEvent.click(screen.getByRole('button', { name: 'Falkor prod' }))
}

const CREATE = /Create the data source and copy the data/

describe('ViewWizard — a package’s data in a new data source', () => {
  const claims = useAuthStore.getState().permissions
  // The mocked store's workspace, as the mock holds it.
  const ws = useWorkspacesStore.getState().workspaces[0] as unknown as { dataSources: Array<Record<string, unknown>> }

  beforeEach(() => {
    localStorage.clear()
    staging = VERSIONED
    // Creating a data source takes the right to manage this workspace's data sources.
    useAuthStore.setState({ permissions: { global: [], ws: { ws1: ['workspace:datasource:manage'] } } } as never)
    inspectPackageMock.mockResolvedValue(packageWithStats())
    reconcileMock.mockResolvedValue(reconciled())
    nameCheckMock.mockImplementation(async (_ws: string, _p: string, name: string) => ({ available: true, normalized: name }))
    suggestMock.mockResolvedValue({ suggested: SUGGESTED, matchingOntologies: [], mergedVariants: {} })
    newSourceMock.mockResolvedValue(STARTED)
    bootstrapStatusMock.mockResolvedValue(SEED_RUNNING)
  })
  afterEach(() => {
    useAuthStore.setState({ permissions: claims } as never)
    ws.dataSources = ws.dataSources.filter(d => d.id !== 'ds_new')
  })

  it('offers a new data source for the data, ready to go on once it is described', async () => {
    renderNewSource()
    await screen.findByText('Import a view with its data')
    await next()                                          // → Target
    expect(await screen.findByText('Suggested for this file')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Into a new data source' }))

    expect(screen.queryByText('Suggested for this file')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Label of the new data source')).toHaveValue('Lineage')
    expect(screen.getByLabelText('Graph name of the new data source')).toHaveValue('lineage_copy')
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()          // no connection yet

    fireEvent.click(screen.getByRole('button', { name: 'Falkor prod' }))
    await waitFor(() => expect(nameCheckMock).toHaveBeenCalledWith('ws1', 'p1', 'lineage_copy'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled())
    fireEvent.change(screen.getByLabelText('Label of the new data source'), { target: { value: '  ' } })
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()

    fireEvent.click(screen.getByRole('radio', { name: 'Into a data source here' }))
    expect(screen.getByText('Suggested for this file')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled()
  })

  it('goes no further without the right to create a data source here', async () => {
    useAuthStore.setState({ permissions: { global: [], ws: {} } } as never)
    renderNewSource()
    await toNewSourceTarget()
    expect(screen.getByText(/needs permission to manage its data sources/)).toBeInTheDocument()
    await waitFor(() => expect(nameCheckMock).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  it('creates the data source once, follows its copy across a reopen, then brings the view in live', async () => {
    suggestMock.mockResolvedValue({ suggested: SUGGESTED, matchingOntologies: [score('onto_ops', 0.2), score('onto_fin', 0.6)], mergedVariants: {} })
    let copied = false
    bootstrapStatusMock.mockImplementation(async () => (copied ? SEED_DONE : SEED_RUNNING))
    importMock.mockResolvedValue(imported('view_new'))
    const first = renderNewSource()
    await toNewSourceTarget()
    expect(await screen.findByText('BEST FIT')).toBeInTheDocument()             // the best fit, chosen for it
    await next()                                          // → Data
    expect(await screen.findByText('Copy the data into a new data source')).toBeInTheDocument()
    expect(screen.getByText(/lineage_copy/)).toBeInTheDocument()
    expect(screen.getByText(/on Falkor prod · Finance \(shared\)/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: CREATE }))

    expect(await screen.findByText('Copying the package')).toBeInTheDocument()
    expect(screen.getByText(/40 of 200 items copied/)).toBeInTheDocument()
    expect(newSourceMock).toHaveBeenCalledTimes(1)
    expect(newSourceMock.mock.calls[0]).toEqual(['up_1', {
      requestId: expect.stringMatching(/^nsr_[0-9a-f]{32}$/), workspaceId: 'ws1', providerId: 'p1',
      label: 'Lineage', graphName: 'lineage_copy', ontologyId: 'onto_fin',
    }])
    expect(bootstrapStatusMock).toHaveBeenCalledWith('ws1', 'ds_new')
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()

    // Closed while it copies, and opened again on the same file: back to following the copy, with
    // no second data source asked for.
    first.unmount()
    renderNewSource()
    await screen.findByText('Import a view with its data')
    await next()
    expect(await screen.findByText('Copying the package')).toBeInTheDocument()
    expect(newSourceMock).toHaveBeenCalledTimes(1)

    copied = true
    expect(await screen.findByText('Everything checked out')).toBeInTheDocument()
    expect(screen.getByText('Next, its view goes into it, live.')).toBeInTheDocument()
    await next()                                          // → Match, in the new data source
    expect(await screen.findByText('How it fits here')).toBeInTheDocument()
    expect(reconcileMock).toHaveBeenCalledWith([expect.objectContaining({
      action: 'create', target: { workspaceId: 'ws1', dataSourceId: 'ds_new' },
    })])
    for (const step of ['basics-step', 'layout-step', 'assignment-step', 'entities-step', 'preview-step']) {
      await next()
      await screen.findByTestId(step)
    }
    expect(screen.getByRole('radio', { name: /Now/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: /Import View/ }))
    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(1))
    expect(importMock.mock.calls[0][0]).toMatchObject({ action: 'create', target: { workspaceId: 'ws1', dataSourceId: 'ds_new' } })
    expect(importMock.mock.calls[0][0].stage).toBeUndefined()
  })

  it('binds the package’s own semantic layer when it comes from this environment', async () => {
    inspectPackageMock.mockResolvedValue(packageWithStats({
      ontologyMatch: { s1: { exact: { ontologyId: 'onto_own', name: 'Lineage ontology', version: 4 }, drift: true, sameEnvironment: true } },
    }))
    renderNewSource()
    await toNewSourceTarget()
    expect(await screen.findByText('Chosen')).toBeInTheDocument()
    expect(screen.getByText(/It has changed since the package was exported/)).toBeInTheDocument()
    await next()                                          // → Data
    fireEvent.click(await screen.findByRole('button', { name: CREATE }))
    await waitFor(() => expect(newSourceMock).toHaveBeenCalledTimes(1))
    expect(newSourceMock.mock.calls[0][1]).toMatchObject({ ontologyId: 'onto_own' })
    expect(suggestMock).not.toHaveBeenCalled()
  })

  it('creates a semantic layer from the package and binds the new data source to it', async () => {
    createLayerMock.mockResolvedValue({
      id: 'onto_draft', name: 'Lineage Schema', version: 1, isPublished: false, entityTypeDefinitions: {}, relationshipTypeDefinitions: {},
    })
    renderNewSource()
    await toNewSourceTarget()
    fireEvent.click(await screen.findByRole('button', { name: /Create from this package/ }))
    expect(await screen.findByText(/“Lineage Schema” was created as a draft/)).toBeInTheDocument()
    expect(createLayerMock).toHaveBeenCalledWith({ ...SUGGESTED, name: 'Lineage Schema' })
    await next()                                          // → Data
    fireEvent.click(await screen.findByRole('button', { name: CREATE }))
    await waitFor(() => expect(newSourceMock).toHaveBeenCalledTimes(1))
    expect(newSourceMock.mock.calls[0][1]).toMatchObject({ ontologyId: 'onto_draft' })
  })

  it('brings every view of the package into it through the batch flow, live', async () => {
    const pair = inspectedPair()
    inspectPackageMock.mockResolvedValue(packageWithStats({ views: pair.views, identityMatches: pair.identityMatches }))
    reconcileEach()
    importMock.mockImplementation(async () => imported('view_new'))
    bootstrapStatusMock.mockResolvedValue(SEED_DONE)
    // What loading the workspaces brings once the copy is done: the new data source.
    ws.dataSources.push({ id: 'ds_new', label: 'Lineage', isPrimary: false })
    renderNewSource()
    await toNewSourceTarget()
    await next()                                          // → Data
    fireEvent.click(await screen.findByRole('button', { name: CREATE }))
    expect(await screen.findByText('Everything checked out')).toBeInTheDocument()
    expect(screen.getByText('Next, its 2 views go into it, live.')).toBeInTheDocument()

    await next()                                          // → the batch's Targets, decided
    expect(await screen.findByText('Where should these views go?')).toBeInTheDocument()
    expect(screen.getByLabelText('Where views from Lineage go')).toHaveValue('ws1|ds_new')
    await next()                                          // → Match: every view new there
    expect(await screen.findByText('How they fit here')).toBeInTheDocument()
    expect(reconcileMock).toHaveBeenCalledWith([
      expect.objectContaining({ key: '0', action: 'create', target: { workspaceId: 'ws1', dataSourceId: 'ds_new' } }),
      expect.objectContaining({ key: '1', action: 'create', target: { workspaceId: 'ws1', dataSourceId: 'ds_new' } }),
    ])
    await next()                                          // → Review
    fireEvent.click(await screen.findByRole('button', { name: /Import 2 views/ }))
    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(2))
    for (const [request] of importMock.mock.calls) expect(request.stage).toBeUndefined()
  })

  it('takes the free graph name offered when its own was taken meanwhile, under the same request id', async () => {
    newSourceMock
      .mockRejectedValueOnce(new ViewTransferError('That graph name is already taken on this connection.', 422,
        'graph_name_unavailable', undefined, { type: 'graph_name_unavailable', suggestion: 'lineage_copy_2' }))
      .mockResolvedValueOnce({ ...STARTED, graphName: 'lineage_copy_2' })
    renderNewSource()
    await toNewSourceTarget()
    await next()                                          // → Data
    fireEvent.click(await screen.findByRole('button', { name: CREATE }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use lineage_copy_2' }))
    fireEvent.click(await screen.findByRole('button', { name: CREATE }))
    await waitFor(() => expect(newSourceMock).toHaveBeenCalledTimes(2))
    const [[, first], [, second]] = newSourceMock.mock.calls
    expect(second).toMatchObject({ graphName: 'lineage_copy_2', requestId: first.requestId })
    expect(await screen.findByText('Copying the package')).toBeInTheDocument()
  })

  it('finishes importing the views of a data source a package made, read again from its upload', async () => {
    getPackageMock.mockResolvedValue(packageWithStats())
    getUploadMock.mockResolvedValue({ uploadId: 'up_1', fileName: 'finance.v7.view-package.zip', size: 2, status: 'ready' })
    bootstrapStatusMock.mockResolvedValue(SEED_DONE)
    renderImport({ importFile: null, importUploadId: 'up_1', initialDataSourceId: 'ds_new' })

    expect(await screen.findByText('Everything checked out')).toBeInTheDocument()
    expect(getPackageMock).toHaveBeenCalledWith('up_1')
    expect(bootstrapStatusMock).toHaveBeenCalledWith('ws1', 'ds_new')
    expect(inspectPackageMock).not.toHaveBeenCalled()
    await next()                                          // → Match, in that data source
    expect(await screen.findByText('How it fits here')).toBeInTheDocument()
    expect(reconcileMock).toHaveBeenCalledWith([expect.objectContaining({
      action: 'create', target: { workspaceId: 'ws1', dataSourceId: 'ds_new' },
    })])
    expect(newSourceMock).not.toHaveBeenCalled()
  })

  it('asks for the file again once the package’s upload has expired', async () => {
    newSourceMock.mockRejectedValue(new ViewTransferError(
      'This package upload is about to expire. Choose the file again to import it.', 410, 'upload_expired'))
    renderNewSource()
    await toNewSourceTarget()
    await next()                                          // → Data
    fireEvent.click(await screen.findByRole('button', { name: CREATE }))
    expect(await screen.findByText('The package’s upload has expired')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Choose the file again/ }))
    expect(await screen.findByText('Drop a view file here')).toBeInTheDocument()
  })
})
