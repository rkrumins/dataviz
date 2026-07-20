/**
 * ViewWizard — RTL tests for the Task 4 rewire: the wizard reads and writes the
 * SAME canonical view-config store as the canvas (layers + flattened assignments
 * in layout.referenceLayout, persisted via updateViewLayout).
 *
 * Every step component is stubbed — this test exercises ViewWizard's OWN wiring
 * (edit-mode hydrate + submit), not the step UIs (covered by their own tests).
 */
import { useEffect, useRef } from 'react'
import { render, screen, fireEvent, waitFor, act, renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { View } from '@/services/viewApiService'
import { useAutoOpenCountdown } from '../CreationPhase'

const getViewMock = vi.fn()
const createViewMock = vi.fn()
const updateViewMock = vi.fn()
const updateViewLayoutMock = vi.fn()
const navigateMock = vi.fn()

// The redirect to the new view is the whole point of the success step — assert it
// directly rather than trusting the router.
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigateMock }
})

vi.mock('@/services/viewApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/viewApiService')>()
  return {
    ...actual,
    getView: (...args: unknown[]) => getViewMock(...args),
    createView: (...args: unknown[]) => createViewMock(...args),
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
// wiring is under test. BasicsStep seeds name/visibleEntityTypes ONLY if still
// blank (create-mode's fresh formData) once the initial render settles — the
// seed is deferred a tick because ViewWizardBody's own "reset on open" effect
// (mode==='create' -> setFormData(makeCreateFormData())) also fires on mount
// and would otherwise stomp a same-tick seed. Reads formData via a ref (kept
// current every render) rather than the effect's closure, so a slower edit-mode
// hydrate that resolves before this fires is never clobbered.
vi.mock('../steps/BasicsStep', () => ({
  BasicsStep: ({ formData, updateFormData }: {
    formData: { name: string }
    updateFormData: (updates: Record<string, unknown>) => void
  }) => {
    const formDataRef = useRef(formData)
    formDataRef.current = formData
    useEffect(() => {
      const t = setTimeout(() => {
        if (!formDataRef.current.name) {
          updateFormData({ name: 'New View', visibleEntityTypes: ['domain'] })
        }
      }, 0)
      return () => clearTimeout(t)
    }, [])
    return <div data-testid="basics-step" />
  },
}))
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

/** Click "Next" through every stubbed step to reach Preview (the last step).
 *  Waits for the button to be enabled first — canProceed may lag a render
 *  behind an async hydrate (edit mode) or a mount effect (create mode's
 *  BasicsStep seed). */
async function goToPreview() {
  for (const step of ['layout-step', 'assignment-step', 'entities-step', 'preview-step']) {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled())
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

describe('ViewWizard — submit (create path) retry', () => {
  it('a retry after updateViewLayout fails re-drives ONLY the layout write, never createView again', async () => {
    createViewMock.mockResolvedValue(makeView(baseConfig({ layers: [], assignments: {} })))
    updateViewLayoutMock.mockRejectedValueOnce(new Error('layout save failed'))
    const onComplete = vi.fn()
    const onClose = vi.fn()

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ViewWizard
            mode="create"
            isOpen
            onClose={onClose}
            onComplete={onComplete}
            initialWorkspaceId="ws1"
            initialDataSourceId="ds1"
          />
        </MemoryRouter>
      </QueryClientProvider>
    )

    // Phase A: confirm scope (initialWorkspaceId/initialDataSourceId pre-fill the picker).
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByTestId('basics-step')
    await goToPreview()

    // First submit: createView succeeds, updateViewLayout fails.
    fireEvent.click(screen.getByRole('button', { name: /create view/i }))
    await waitFor(() => expect(createViewMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(updateViewLayoutMock).toHaveBeenCalledTimes(1))
    expect(onComplete).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    // The failure is now shown as a stalled stage with a Retry, instead of a
    // silent no-op behind the footer button.
    const retry = await screen.findByRole('button', { name: /^retry$/i })

    // Retry: must NOT call createView again (would mint a second view); must
    // re-drive updateViewLayout against the SAME id captured from the first call.
    updateViewLayoutMock.mockResolvedValueOnce(makeView(baseConfig({ layers: [], assignments: {} })))
    fireEvent.click(retry)

    await waitFor(() => expect(updateViewLayoutMock).toHaveBeenCalledTimes(2))
    expect(createViewMock).toHaveBeenCalledTimes(1)
    const [firstCallId] = updateViewLayoutMock.mock.calls[0]
    const [secondCallId] = updateViewLayoutMock.mock.calls[1]
    expect(secondCallId).toBe(firstCallId)

    // The view is saved, so the wizard hands over rather than vanishing: the
    // success step offers to open it.
    const openNow = await screen.findByRole('button', { name: /open view now/i })

    // CRITICAL: onComplete is what CLOSES the wizard (AppLayout wires it to
    // closeViewEditor). Firing it on save would unmount the success step and kill
    // the redirect with it — which is exactly the bug this pins. Nothing leaves
    // until the user does.
    expect(onComplete).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(navigateMock).not.toHaveBeenCalled()

    fireEvent.click(openNow)

    expect(navigateMock).toHaveBeenCalledWith('/views/v1')
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('offers to open the view itself, counting down', async () => {
    createViewMock.mockResolvedValue(makeView(baseConfig({ layers: [], assignments: {} })))
    updateViewLayoutMock.mockResolvedValue(makeView(baseConfig({ layers: [], assignments: {} })))

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ViewWizard
            mode="create"
            isOpen
            onClose={vi.fn()}
            onComplete={vi.fn()}
            initialWorkspaceId="ws1"
            initialDataSourceId="ds1"
          />
        </MemoryRouter>
      </QueryClientProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByTestId('basics-step')
    await goToPreview()
    fireEvent.click(screen.getByRole('button', { name: /create view/i }))

    await screen.findByRole('button', { name: /open view now/i })
    // The auto-open is advertised, not silent (the firing itself is pinned by the
    // useAutoOpenCountdown tests at the bottom of this file). The seconds sit in
    // their own element, so match on the whole line rather than a single text node.
    expect(
      screen.getByText(
        (_content, el) =>
          el?.tagName === 'P' && /opening automatically in \d+s/i.test(el.textContent ?? ''),
      ),
    ).toBeInTheDocument()
  })

  it('stays put (no redirect) when the user chooses to stay here', async () => {
    createViewMock.mockResolvedValue(makeView(baseConfig({ layers: [], assignments: {} })))
    updateViewLayoutMock.mockResolvedValue(makeView(baseConfig({ layers: [], assignments: {} })))
    const onComplete = vi.fn()
    const onClose = vi.fn()

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ViewWizard
            mode="create"
            isOpen
            onClose={onClose}
            onComplete={onComplete}
            initialWorkspaceId="ws1"
            initialDataSourceId="ds1"
          />
        </MemoryRouter>
      </QueryClientProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByTestId('basics-step')
    await goToPreview()
    fireEvent.click(screen.getByRole('button', { name: /create view/i }))

    fireEvent.click(await screen.findByRole('button', { name: /stay here/i }))

    expect(navigateMock).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clears the autosaved draft once the view is fully saved', async () => {
    createViewMock.mockResolvedValue(makeView(baseConfig({ layers: [], assignments: {} })))
    updateViewLayoutMock.mockResolvedValue(makeView(baseConfig({ layers: [], assignments: {} })))
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem')

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ViewWizard
            mode="create"
            isOpen
            onClose={vi.fn()}
            onComplete={vi.fn()}
            initialWorkspaceId="ws1"
            initialDataSourceId="ds1"
          />
        </MemoryRouter>
      </QueryClientProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByTestId('basics-step')
    await goToPreview()
    fireEvent.click(screen.getByRole('button', { name: /create view/i }))

    await screen.findByRole('button', { name: /open view now/i })
    expect(removeItem).toHaveBeenCalledWith(
      expect.stringContaining('viz-view-wizard-draft:ws1:ds1'),
    )
    removeItem.mockRestore()
  })
})

/**
 * The auto-open itself, unit-tested. Deliberately NOT exercised through the full
 * wizard: installing fake timers around a React tree wedges React's own scheduler
 * and silently breaks every test that follows it in the file.
 */
describe('useAutoOpenCountdown', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** Each tick must be its own act(): the next timeout is only scheduled once
   *  React has re-rendered with the decremented value. */
  const tick = (seconds: number) => {
    for (let i = 0; i < seconds; i++) {
      act(() => { vi.advanceTimersByTime(1000) })
    }
  }

  it('opens the view once the countdown runs out — and only once', () => {
    const onFire = vi.fn()
    renderHook(() => useAutoOpenCountdown({ enabled: true, seconds: 3, onFire }))

    tick(2)
    expect(onFire).not.toHaveBeenCalled()

    tick(1)
    expect(onFire).toHaveBeenCalledTimes(1)

    // A stray tick must never fire a second navigation.
    tick(5)
    expect(onFire).toHaveBeenCalledTimes(1)
  })

  it('runs on its own — there is no hover-pause to stall it', () => {
    // The pause used to make this hook useless in practice: after clicking
    // "Create" the pointer is already over the modal, so the countdown started
    // paused and the auto-open never happened. Cancelling is now an explicit act.
    const onFire = vi.fn()
    const { result } = renderHook(() => useAutoOpenCountdown({ enabled: true, seconds: 3, onFire }))

    expect(result.current).not.toHaveProperty('setPaused')
    tick(3)

    expect(onFire).toHaveBeenCalledTimes(1)
  })

  it('never fires after the user takes over (cancel)', () => {
    const onFire = vi.fn()
    const { result } = renderHook(() => useAutoOpenCountdown({ enabled: true, seconds: 3, onFire }))

    act(() => { result.current.cancel() })
    tick(10)

    expect(onFire).not.toHaveBeenCalled()
  })

  it('does nothing until the wizard actually reaches the success step', () => {
    const onFire = vi.fn()
    renderHook(() => useAutoOpenCountdown({ enabled: false, seconds: 3, onFire }))

    tick(10)
    expect(onFire).not.toHaveBeenCalled()
  })
})

describe('ViewWizard — node-ordering side-fields survive an edit-mode save', () => {
  it('round-trips defaultNodeSortMode and assignment orderKeys through submit', async () => {
    renderWizard(makeView(baseConfig({
      layers: [{ id: 'l1', name: 'Layer 1', entityTypes: [], order: 0, nodeSortMode: 'custom' }],
      assignments: { 'urn:a': { layerId: 'l1', inheritsChildren: true, orderKey: 'a1' } },
      defaultNodeSortMode: 'alpha-desc',
    })))

    await screen.findByTestId('basics-step')
    await goToPreview()
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(updateViewLayoutMock).toHaveBeenCalled())
    const [, body] = updateViewLayoutMock.mock.calls[0]
    // The wizard rebuilds the layout from form state — the scalar view default
    // and per-assignment orderKeys must ride through, not be wiped.
    expect(body.referenceLayout.defaultNodeSortMode).toBe('alpha-desc')
    expect(body.referenceLayout.assignments['urn:a'].orderKey).toBe('a1')
    expect(body.referenceLayout.layers[0].nodeSortMode).toBe('custom')
  })
})
