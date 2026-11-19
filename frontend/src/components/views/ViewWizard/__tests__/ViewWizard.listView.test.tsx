/**
 * ViewWizard — editing a view made from a query (`config.membership`), and a subset view.
 *
 * Its query places its members in its layers, so it is a Context View whatever the wizard says:
 *   - it edits with reduced steps — Basics, how its own layers look (none for one that follows
 *     another view), Preview — and is offered no layout type, scope or placements;
 *   - a save sends its layout type as stored, and writes no layout unless its layers were
 *     restyled; then only their look, its placements and side fields as stored, and no scope;
 *   - a subset view's save writes no layout at all;
 *   - a refusal from the server (`list_view_context_only`) is said in words, and the modal stays.
 *
 * The steps are stubbed: what is under test is the wizard's own wiring.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { View } from '@/services/viewApiService'
import type { ViewLayerConfig } from '@/types/schema'

const getViewMock = vi.fn()
const updateViewMock = vi.fn()
const updateViewLayoutMock = vi.fn()

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => vi.fn() }
})
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
    workspaces: [{ id: 'ws1', name: 'Workspace 1', dataSources: [{ id: 'ds1', label: 'DS1', isPrimary: true, ontologyId: 'onto1' }] }],
    loadWorkspaces: vi.fn().mockResolvedValue(undefined),
  }
  const useWorkspacesStore = Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state,
  })
  return { useWorkspacesStore }
})
vi.mock('../steps/BasicsStep', () => ({ BasicsStep: () => <div data-testid="basics-step" /> }))
// The real step's look-only mode is pinned in LayoutStep.test.tsx; this stand-in says what it was
// handed, and makes the gestures a save must keep in bounds — a restyle, and the two it must not
// write for this view even if a step asked for them.
vi.mock('../steps/LayoutStep', () => ({
  LayoutStep: ({ formData, updateFormData, lookOnly }: {
    formData: { layers: ViewLayerConfig[] }
    updateFormData: (u: Record<string, unknown>) => void
    lookOnly?: boolean
  }) => (
    <div data-testid="layout-step">
      <span data-testid="layout-look-only">{String(!!lookOnly)}</span>
      <button onClick={() => updateFormData({
        layers: formData.layers.map(l => (l.id === 'l1' ? { ...l, name: 'Where it comes from', color: '#ef4444' } : l)),
      })}>stub-restyle</button>
      <button onClick={() => updateFormData({ layoutType: 'graph' })}>stub-pick-graph</button>
      <button onClick={() => updateFormData({ entityScope: 'all' })}>stub-pin-open-scope</button>
    </div>
  ),
}))
vi.mock('../steps/EntitiesStep', () => ({ EntitiesStep: () => <div data-testid="entities-step" /> }))
vi.mock('../steps/PreviewStep', () => ({
  PreviewStep: ({ madeFromQuery }: { madeFromQuery?: boolean }) => (
    <div data-testid="preview-step">{madeFromQuery ? 'shows its members' : 'shows what is placed'}</div>
  ),
}))
vi.mock('../steps/AssignmentStep', () => ({ AssignmentStep: () => <div data-testid="assignment-step" /> }))
vi.mock('../steps/ScopeStep', () => ({ ScopeStep: () => <div data-testid="scope-step" /> }))

import { ViewWizard } from '../ViewWizard'

const LAYERS = [
  { id: 'l1', name: 'Sources', color: '#3b82f6', entityTypes: [], order: 0 },
  { id: 'other', name: 'Other', color: '#94a3b8', entityTypes: [], order: 1 },
]

/** A list view as `/views/from-members` makes it: its own layers, an entry it always includes,
 *  a display rule, and its definition. */
function listView(layout: 'source' | 'follow' = 'source', mode: 'live' | 'snapshot' = 'live'): View {
  return {
    id: 'v1', name: 'Payments made from a query', workspaceId: 'ws1', dataSourceId: 'ds1',
    viewType: 'reference', layoutType: 'reference', visibility: 'private',
    isPinned: false, favouriteCount: 0, isFavourited: false,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    config: {
      icon: 'Layout',
      content: { visibleEntityTypes: ['dataset'], visibleRelationshipTypes: [], defaultDepth: 5, maxDepth: 10, entityScope: 'curated' },
      layout: {
        type: 'reference',
        referenceLayout: layout === 'follow' ? { layers: [], assignments: {} } : {
          layers: LAYERS,
          assignments: { 'urn:pinned': { layerId: 'l1', inheritsChildren: true } },
          displayRules: [{ id: 'hot', op: 'color', value: '#f00' }],
        },
        lod: { enabled: false, levels: [] },
      },
      filters: { entityTypeFilters: [], fieldFilters: [], searchableFields: [], quickFilters: [] },
      entityOverrides: {},
      membership: {
        v: 1, mode, sources: [], layout: { kind: layout, sourceViewId: 'v_base' }, exclude: [], overrides: {},
        provenance: { origin: 'narrow' },
      },
    },
  } as View
}

function subsetView(): View {
  const view = listView()
  const config: Record<string, unknown> = { ...view.config }
  delete config.membership
  return { ...view, config: { ...config, search: { v: 1, predicate: {}, within: 'view', readIn: 'v_base', layout: 'own', provenance: { origin: 'search' } } } }
}

function renderWizard(view: View, onClose = vi.fn()) {
  getViewMock.mockResolvedValue(view)
  updateViewMock.mockResolvedValue(view)
  updateViewLayoutMock.mockResolvedValue(view)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ViewWizard mode="edit" viewId="v1" isOpen onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { onClose }
}

async function next(step: string) {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled())
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByTestId(step)
}

async function save() {
  fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
  await waitFor(() => expect(updateViewMock).toHaveBeenCalledTimes(1))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ViewWizard — a view made from a query', () => {
  it('edits its details, how its layers look and who can see it — no scope, placements or other layout', async () => {
    renderWizard(listView())
    await screen.findByTestId('basics-step')
    expect(await screen.findByText(/This view is made from a query/)).toBeInTheDocument()
    expect(screen.getByTitle('Basics')).toBeInTheDocument()
    expect(screen.getByTitle('Layers')).toBeInTheDocument()
    expect(screen.getByTitle('Preview')).toBeInTheDocument()
    for (const step of ['Scope', 'Assignments', 'Entities']) expect(screen.queryByTitle(step)).not.toBeInTheDocument()

    await next('layout-step')
    expect(screen.getByTestId('layout-look-only')).toHaveTextContent('true')
    await next('preview-step')
    expect(screen.getByText('shows its members')).toBeInTheDocument()
  })

  it('has no layers to restyle when it follows another view: they are that view’s', async () => {
    renderWizard(listView('follow'))
    await screen.findByTestId('basics-step')
    await waitFor(() => expect(screen.getByTitle('Preview')).toBeInTheDocument())
    expect(screen.queryByTitle('Layers')).not.toBeInTheDocument()
    await next('preview-step')
  })

  it('saves its details as a Context View still, and writes no layout when its layers are untouched', async () => {
    const { onClose } = renderWizard(listView('source', 'snapshot'))
    await screen.findByTestId('basics-step')
    await next('layout-step')
    fireEvent.click(screen.getByText('stub-pick-graph'))
    fireEvent.click(screen.getByText('stub-pin-open-scope'))
    await next('preview-step')
    await save()

    const [, body] = updateViewMock.mock.calls[0]
    expect(body.viewType).toBe('reference')
    expect(body.config.layout.type).toBe('reference')
    // Its definition and its scope ride along as they are.
    expect(body.config.membership).toEqual(listView('source', 'snapshot').config.membership)
    expect(body.config.content.entityScope).toBe('curated')
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(updateViewLayoutMock).not.toHaveBeenCalled()
  })

  it('writes only how its layers look: its placements and side fields as stored, and no scope', async () => {
    renderWizard(listView())
    await screen.findByTestId('basics-step')
    await next('layout-step')
    fireEvent.click(screen.getByText('stub-restyle'))
    fireEvent.click(screen.getByText('stub-pin-open-scope'))
    await next('preview-step')
    await save()

    await waitFor(() => expect(updateViewLayoutMock).toHaveBeenCalledTimes(1))
    const [viewId, body] = updateViewLayoutMock.mock.calls[0]
    expect(viewId).toBe('v1')
    expect(body.referenceLayout.layers).toEqual([
      { ...LAYERS[0], name: 'Where it comes from', color: '#ef4444' },
      LAYERS[1],
    ])
    expect(body.referenceLayout.assignments).toEqual({ 'urn:pinned': { layerId: 'l1', inheritsChildren: true } })
    expect(body.referenceLayout.displayRules).toEqual([{ id: 'hot', op: 'color', value: '#f00' }])
    expect(body).not.toHaveProperty('entityScope')
    expect(body.checkpoint).toEqual({ source: 'wizard' })
  })

  it('says in words why the server refused a save, and stays open', async () => {
    const { onClose } = renderWizard(listView())
    updateViewMock.mockRejectedValue(Object.assign(
      new Error('A view made from a query is a Context View: its layout type and scope can’t change.'),
      { status: 422, detail: { type: 'list_view_context_only' } },
    ))
    await screen.findByTestId('basics-step')
    await next('layout-step')
    await next('preview-step')
    await save()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A view made from a query is a Context View: its layout type and scope can’t change.',
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument()
  })

  it('says it in its own words when the refusal carries none', async () => {
    renderWizard(listView())
    updateViewLayoutMock.mockRejectedValue(Object.assign(new Error('{"type":"list_view_context_only"}'), { status: 422 }))
    await screen.findByTestId('basics-step')
    await next('layout-step')
    fireEvent.click(screen.getByText('stub-restyle'))
    await next('preview-step')
    await save()

    expect(await screen.findByRole('alert')).toHaveTextContent(/can only be a Context View/)
  })
})

describe('ViewWizard — a subset view', () => {
  it('saves its details and writes no layout: its layers and scope are its search’s', async () => {
    const { onClose } = renderWizard(subsetView())
    await screen.findByTestId('basics-step')
    await next('preview-step')
    await save()

    const [, body] = updateViewMock.mock.calls[0]
    expect(body.viewType).toBe('reference')
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(updateViewLayoutMock).not.toHaveBeenCalled()
  })
})
