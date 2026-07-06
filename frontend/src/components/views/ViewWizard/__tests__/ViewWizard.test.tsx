/**
 * ViewWizard — RTL tests for the Task 4 rewire: the wizard reads and writes the
 * SAME canonical view-config store as the canvas (layers + flattened assignments
 * in layout.referenceLayout, persisted via updateViewLayout).
 *
 * Every step component is stubbed — this test exercises ViewWizard's OWN wiring
 * (edit-mode hydrate + submit), not the step UIs (covered by their own tests).
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { View } from '@/services/viewApiService'

const getViewMock = vi.fn()
const updateViewMock = vi.fn()
const updateViewLayoutMock = vi.fn()

vi.mock('@/services/viewApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/viewApiService')>()
  return {
    ...actual,
    getView: (...args: unknown[]) => getViewMock(...args),
    updateView: (...args: unknown[]) => updateViewMock(...args),
    updateViewLayout: (...args: unknown[]) => updateViewLayoutMock(...args),
  }
})

vi.mock('@/components/schema/SchemaScope', () => ({
  SchemaScope: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/store/workspaces', () => {
  const state = {
    activeWorkspaceId: null,
    activeDataSourceId: null,
    workspaces: [
      { id: 'ws1', name: 'Workspace 1', dataSources: [{ id: 'ds1', label: 'DS1', isPrimary: true, ontologyId: 'onto1' }] },
    ],
    loadWorkspaces: vi.fn().mockResolvedValue(undefined),
  }
  const useWorkspacesStore = Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state,
  })
  return { useWorkspacesStore }
})

// Every step is a black box for this test — only ViewWizard's own hydrate/submit
// wiring is under test.
vi.mock('../steps/BasicsStep', () => ({ BasicsStep: () => <div data-testid="basics-step" /> }))
vi.mock('../steps/LayoutStep', () => ({ LayoutStep: () => <div data-testid="layout-step" /> }))
vi.mock('../steps/EntitiesStep', () => ({ EntitiesStep: () => <div data-testid="entities-step" /> }))
vi.mock('../steps/PreviewStep', () => ({ PreviewStep: () => <div data-testid="preview-step" /> }))
vi.mock('../steps/AssignmentStep', () => ({ AssignmentStep: () => <div data-testid="assignment-step" /> }))
vi.mock('../steps/ScopeStep', () => ({ ScopeStep: () => <div data-testid="scope-step" /> }))

import { ViewWizard } from '../ViewWizard'

function baseConfig(referenceLayout: Record<string, unknown>) {
  return {
    icon: 'Layout',
    content: {
      visibleEntityTypes: ['domain', 'dataset'],
      visibleRelationshipTypes: ['contains'],
      defaultDepth: 5,
      maxDepth: 10,
      rootEntityTypes: ['domain'],
    },
    layout: {
      type: 'reference',
      referenceLayout,
      lod: { enabled: false, levels: [] },
    },
    filters: { entityTypeFilters: [], fieldFilters: [], searchableFields: [], quickFilters: [] },
    entityOverrides: {},
  }
}

function makeView(config: Record<string, unknown>): View {
  return {
    id: 'v1',
    name: 'My View',
    workspaceId: 'ws1',
    dataSourceId: 'ds1',
    viewType: 'reference',
    layoutType: 'reference',
    config,
    visibility: 'private',
    isPinned: false,
    favouriteCount: 0,
    isFavourited: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as View
}

function renderWizard(view: View) {
  getViewMock.mockResolvedValue(view)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ViewWizard mode="edit" viewId="v1" isOpen onClose={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

/** Click "Next" through every stubbed step to reach Preview (the last step). */
async function goToPreview() {
  for (const step of ['layout-step', 'assignment-step', 'entities-step', 'preview-step']) {
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByTestId(step)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  updateViewMock.mockResolvedValue(makeView(baseConfig({ layers: [], assignments: {} })))
  updateViewLayoutMock.mockResolvedValue(makeView(baseConfig({ layers: [], assignments: {} })))
})

describe('ViewWizard — edit-mode hydrate', () => {
  it('maps a canonical view config (top-level assignments) into formData, visible at Submit', async () => {
    renderWizard(makeView(baseConfig({
      layers: [{ id: 'l1', name: 'Layer 1', entityTypes: [], order: 0 }],
      assignments: { 'urn:canonical': { layerId: 'l1', inheritsChildren: true } },
    })))

    await screen.findByTestId('basics-step')
    await goToPreview()
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(updateViewLayoutMock).toHaveBeenCalled())
    const [, body] = updateViewLayoutMock.mock.calls[0]
    expect(body.referenceLayout.assignments).toMatchObject({ 'urn:canonical': { layerId: 'l1' } })
  })

  it('up-converts a legacy view config (per-layer entityAssignments) into formData.assignments', async () => {
    renderWizard(makeView(baseConfig({
      layers: [{
        id: 'l1',
        name: 'Layer 1',
        entityTypes: [],
        order: 0,
        entityAssignments: [
          { entityId: 'urn:legacy', layerId: 'l1', inheritsChildren: true, priority: 1000, assignedBy: 'user' },
        ],
      }],
    })))

    await screen.findByTestId('basics-step')
    await goToPreview()
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(updateViewLayoutMock).toHaveBeenCalled())
    const [, body] = updateViewLayoutMock.mock.calls[0]
    expect(body.referenceLayout.assignments).toMatchObject({ 'urn:legacy': { layerId: 'l1' } })
    // entityAssignments must be stripped from the layer, never re-embedded
    expect(body.referenceLayout.layers[0].entityAssignments).toBeUndefined()
  })
})

describe('ViewWizard — submit (edit path)', () => {
  it('calls updateViewLayout with the submitted layers+assignments and a derived entityScope', async () => {
    renderWizard(makeView(baseConfig({
      layers: [{ id: 'l1', name: 'Layer 1', entityTypes: [], order: 0 }],
      assignments: { 'urn:a': { layerId: 'l1', inheritsChildren: true } },
    })))

    await screen.findByTestId('basics-step')
    await goToPreview()
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(updateViewMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(updateViewLayoutMock).toHaveBeenCalledTimes(1))

    // updateView (the plain config PUT) must not have raced/lost the layout —
    // it's called with the base config so buildViewConfig preserves referenceLayout
    // verbatim; the layout endpoint is the one that actually writes layers/assignments.
    const [viewId, body] = updateViewLayoutMock.mock.calls[0]
    expect(viewId).toBe('v1')
    expect(body.referenceLayout.layers).toEqual([{ id: 'l1', name: 'Layer 1', entityTypes: [], order: 0 }])
    expect(body.referenceLayout.assignments).toEqual({ 'urn:a': { layerId: 'l1', inheritsChildren: true } })
    expect(body.entityScope).toBe('curated')
  })

  it('preserves an explicit editingView.content.entityScope rather than deriving it', async () => {
    const config = baseConfig({
      layers: [{ id: 'l1', name: 'Layer 1', entityTypes: [], order: 0 }],
      assignments: {},
    })
    ;(config.content as Record<string, unknown>).entityScope = 'curated'
    renderWizard(makeView(config))

    await screen.findByTestId('basics-step')
    await goToPreview()
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(updateViewLayoutMock).toHaveBeenCalledTimes(1))
    const [, body] = updateViewLayoutMock.mock.calls[0]
    // No assignments were submitted, but the explicit prior 'curated' scope wins
    // over the "no assignments -> all" derivation.
    expect(body.entityScope).toBe('curated')
  })

  it('leaves the modal open (no onClose/onComplete) when updateViewLayout fails', async () => {
    updateViewLayoutMock.mockRejectedValue(new Error('layout save failed'))
    const onComplete = vi.fn()
    const onClose = vi.fn()
    const view = makeView(baseConfig({
      layers: [{ id: 'l1', name: 'Layer 1', entityTypes: [], order: 0 }],
      assignments: {},
    }))
    getViewMock.mockResolvedValue(view)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ViewWizard mode="edit" viewId="v1" isOpen onClose={onClose} onComplete={onComplete} />
        </MemoryRouter>
      </QueryClientProvider>
    )

    await screen.findByTestId('basics-step')
    await goToPreview()
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(updateViewLayoutMock).toHaveBeenCalledTimes(1))
    // The view's own fields were saved (updateView succeeded); only the layout
    // write failed — the modal must stay open rather than silently discarding
    // the user's layer/assignment edits.
    expect(updateViewMock).toHaveBeenCalledTimes(1)
    expect(onComplete).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument()
  })
})
