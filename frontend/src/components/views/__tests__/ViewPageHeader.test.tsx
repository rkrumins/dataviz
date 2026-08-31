/**
 * ViewPageHeader pins:
 *   - a pending publication request is visible ON the view, naming who
 *     asked and when (it used to live only in the admin queue and inside
 *     the Share dialog, so the view itself said nothing);
 *   - it is only a BUTTON — a route into the dialog where approve/decline
 *     live — for a caller who can actually answer it; everyone else gets
 *     a read-only badge;
 *   - no request, no badge;
 *   - the view says what it is BUILT ON: the data source (free on the
 *     response already in flight) opens the full account — and reaches a
 *     viewer who cannot edit, which the edit-gated Details button never did;
 *   - the identity line says what KIND of thing each fact is: a view type,
 *     a workspace you can walk to, a data source. The workspace is a link
 *     only for someone the workspace would actually open for;
 *   - WHO CAN SEE THIS VIEW is on the view, as a control for anyone who can
 *     act on it and as a plain badge for everyone else. It was previously
 *     unobtainable from the canvas at any price;
 *   - and what the canvas toolbar's DUPLICATE title block used to carry, now
 *     that the duplicate is gone: the entity-type count reads as a fact on the
 *     identity line, double-click-to-rename came with the name it renames, and
 *     Reviews joined Details and Activity. (Edit details and Share are not
 *     duplicated — the Details button and the audience control already opened
 *     the very same form and the very same dialog.)
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/viewApiService', async () => {
  const actual = await vi.importActual<typeof import('@/services/viewApiService')>(
    '@/services/viewApiService',
  )
  return { ...actual, getView: vi.fn(), updateView: vi.fn() }
})
vi.mock('@/store/schema', () => ({
  useSchemaStore: (selector: (s: unknown) => unknown) => selector({ updateView: vi.fn() }),
}))
// The panels are exercised by their own suites; here they are noise — except
// for the props this host is responsible for choosing, which are recorded.
const { editPanelProps } = vi.hoisted(() => ({ editPanelProps: vi.fn() }))
vi.mock('@/components/views/EditDetailsPanel', () => ({
  EditDetailsPanel: (props: Record<string, unknown>) => {
    editPanelProps(props)
    return <div data-testid="edit-details-form" />
  },
}))
// Mounted only inside the opened sheet — that is what keeps its two
// membership-gated lookups off the canvas-open path.
vi.mock('@/components/views/ViewBuiltOn', () => ({
  ViewBuiltOn: () => <div data-testid="built-on-account" />,
}))
vi.mock('@/components/views/ViewActivityDrawer', () => ({ ViewActivityDrawer: () => null }))
// Whether there is anything to review is the button's OWN question (feature
// flag, resolved graph, seeded head) and it has its own suite; here the header
// only decides whether to offer it at all.
vi.mock('@/features/versioning/components/ViewReviewsButton', () => ({
  ViewReviewsButton: () => <button type="button">Reviews</button>,
}))
vi.mock('@/components/views/ShareViewDialog', () => ({
  ShareViewDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="share-dialog" /> : null,
}))

import { ViewPageHeader } from '../ViewPageHeader'
import {
  getView,
  updateView,
  type View,
  type ViewAccess,
  type ViewPublishRequest,
} from '@/services/viewApiService'
import { useWorkspacesStore } from '@/store/workspaces'
import type { WorkspaceResponse } from '@/services/workspaceService'

const mockGetView = vi.mocked(getView)
const mockUpdateView = vi.mocked(updateView)

const OWNER_ACCESS: ViewAccess = {
  canEdit: true,
  canManageGrants: true,
  canChangeVisibility: true,
  canPublish: false,
  canRequestPublish: true,
  accessVia: 'owner',
  dataAccess: 'full',
}

/** Someone who was let in and can change nothing about the view's audience. */
const VIEWER_ACCESS: ViewAccess = {
  canEdit: false,
  canManageGrants: false,
  canChangeVisibility: false,
  canPublish: false,
  canRequestPublish: false,
  accessVia: 'enterprise',
  dataAccess: 'readonly',
}

/** Holds the publish permission, so the badge becomes a route. */
const ANSWERER_ACCESS: ViewAccess = {
  ...OWNER_ACCESS,
  canPublish: true,
  canAnswerPublishRequest: true,
}

/** Relative so the "3d ago" assertion never depends on today's date. */
const THREE_DAYS_AGO = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()

const PENDING: ViewPublishRequest = {
  requestedBy: 'usr_ada',
  requestedByName: 'Ada Lovelace',
  requestedAt: THREE_DAYS_AGO,
  note: 'The whole company needs this map.',
}

function viewResponse(overrides: Partial<View> = {}): View {
  return {
    id: 'view_1',
    name: 'Test View',
    workspaceId: 'ws_1',
    viewType: 'graph',
    config: {},
    visibility: 'workspace',
    isPinned: false,
    favouriteCount: 0,
    isFavourited: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

/** The workspace store lists only workspaces the caller BELONGS to, which is
 *  the same test as "will /workspaces/{id} open for them?". */
function joinWorkspace(id = 'ws_1') {
  useWorkspacesStore.setState({
    workspaces: [{
      id, name: 'Finance', dataSources: [], isDefault: true, isActive: true,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    } satisfies WorkspaceResponse],
  })
}

function renderHeader(view: View) {
  mockGetView.mockResolvedValue(view)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ViewPageHeader viewId="view_1" workspaceName="Finance" />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  useWorkspacesStore.setState({ workspaces: [] })
})

describe('pending publication request', () => {
  it('is a read-only badge naming the requester and when, for someone who cannot answer', async () => {
    renderHeader(viewResponse({ access: OWNER_ACCESS, publishRequest: PENDING }))
    const badge = await screen.findByText('Publication requested')
    expect(badge.tagName).toBe('SPAN')
    expect(badge.getAttribute('title')).toMatch(/Asked by Ada Lovelace 3d ago/)
    expect(badge.getAttribute('title')).toMatch(/a workspace admin decides/)
  })

  it('becomes a button into the share dialog when the caller can answer it', async () => {
    renderHeader(viewResponse({ access: ANSWERER_ACCESS, publishRequest: PENDING }))
    const badge = await screen.findByText('Publication requested')
    expect(badge.tagName).toBe('BUTTON')
    expect(badge.getAttribute('title')).toMatch(/Asked by Ada Lovelace 3d ago/)

    expect(screen.queryByTestId('share-dialog')).toBeNull()
    fireEvent.click(badge)
    expect(screen.getByTestId('share-dialog')).toBeTruthy()
  })

  it('names the requester generically when the asking account is gone', async () => {
    renderHeader(viewResponse({
      access: OWNER_ACCESS,
      publishRequest: { ...PENDING, requestedByName: null },
    }))
    const badge = await screen.findByText('Publication requested')
    expect(badge.getAttribute('title')).toMatch(/Asked by a workspace member/)
  })

  it('renders no badge without a request', async () => {
    renderHeader(viewResponse({ access: OWNER_ACCESS }))
    await screen.findByText('Test View')
    expect(screen.queryByText('Publication requested')).toBeNull()
  })
})

describe('the identity line', () => {
  it('names the KIND of view, not just the view', async () => {
    renderHeader(viewResponse({ access: OWNER_ACCESS }))
    expect(await screen.findByText('Graph')).toBeInTheDocument()
  })

  it('walks to the workspace it lives in', async () => {
    joinWorkspace()
    renderHeader(viewResponse({ access: OWNER_ACCESS }))
    const link = await screen.findByRole('link', { name: /open the Finance workspace/i })
    expect(link.getAttribute('href')).toBe('/workspaces/ws_1')
  })

  it('still names the workspace for a non-member — but never as a dead link', async () => {
    // A shared/enterprise reader is not in the workspace store, and
    // /workspaces/{id} would refuse them. The fact survives; the route does not.
    renderHeader(viewResponse({ access: VIEWER_ACCESS }))
    expect(await screen.findByText('Finance')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Finance workspace/i })).toBeNull()
  })
})

describe('Share, and the audience it changes', () => {
  it('is one control that says both — the verb, and the tier it would change', async () => {
    renderHeader(viewResponse({ access: OWNER_ACCESS }))
    const control = await screen.findByRole('button', {
      name: /share — who can see this view: Workspace/i,
    })
    expect(screen.queryByTestId('share-dialog')).toBeNull()
    fireEvent.click(control)
    expect(screen.getByTestId('share-dialog')).toBeTruthy()
  })

  it('is findable by the word people come looking for', async () => {
    // The canvas title menu's item was literally "Share…". Whatever else this
    // control carries, the verb has to be on it.
    renderHeader(viewResponse({ access: OWNER_ACCESS }))
    expect(await screen.findByText('Share')).toBeInTheDocument()
  })

  it('still shares a view whose stored tier this app cannot name', async () => {
    // `ck_views_visibility` also permits the legacy 'public', and live rows
    // carry it. Naming the tier and offering the ACTION are different
    // questions: gating the control on the first is what took the only route
    // to the Share dialog away from an owner holding every sharing right.
    renderHeader(viewResponse({
      access: OWNER_ACCESS,
      visibility: 'public' as View['visibility'],
    }))
    const control = await screen.findByRole('button', { name: 'Share' })
    // …and it names no tier, rather than rendering a chip with a missing icon.
    expect(control.textContent).not.toMatch(/workspace|private|enterprise|public/i)

    fireEvent.click(control)
    expect(screen.getByTestId('share-dialog')).toBeTruthy()
  })

  it('is a plain badge — the tier, no verb — for someone who can change nothing', async () => {
    renderHeader(viewResponse({ access: VIEWER_ACCESS, visibility: 'enterprise' }))
    expect(await screen.findByLabelText(/who can see this view: Enterprise/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /share/i })).toBeNull()
  })

  it('shows nothing at all when there is neither a tier to name nor a right to act', async () => {
    renderHeader(viewResponse({
      access: VIEWER_ACCESS,
      visibility: 'public' as View['visibility'],
    }))
    await screen.findByText('Test View')
    expect(screen.queryByLabelText(/who can see this view/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /share/i })).toBeNull()
  })
})

describe('what this view is built on', () => {
  it('names the data source, labelled for a screen reader', async () => {
    renderHeader(viewResponse({
      access: OWNER_ACCESS,
      dataSourceId: 'ds_1',
      dataSourceName: 'Production Warehouse',
    }))
    const chip = await screen.findByRole('button', {
      name: /what this view is built on: Production Warehouse/i,
    })
    expect(chip.textContent).toContain('Production Warehouse')
  })

  it('renders nothing when the view has no resolved data source', async () => {
    renderHeader(viewResponse({ access: OWNER_ACCESS }))
    await screen.findByText('Test View')
    expect(screen.queryByRole('button', { name: /built on/i })).toBeNull()
  })

  it('mounts the account only once it is clicked', async () => {
    renderHeader(viewResponse({
      access: OWNER_ACCESS,
      dataSourceId: 'ds_1',
      dataSourceName: 'Production Warehouse',
    }))
    const chip = await screen.findByRole('button', { name: /built on/i })
    expect(screen.queryByTestId('built-on-account')).toBeNull()
    fireEvent.click(chip)
    expect(screen.getByTestId('built-on-account')).toBeTruthy()
  })

  it('reaches a viewer who cannot edit — and shows them no edit form', async () => {
    renderHeader(viewResponse({
      access: { ...OWNER_ACCESS, canEdit: false, accessVia: 'enterprise' },
      dataSourceId: 'ds_1',
      dataSourceName: 'Production Warehouse',
    }))
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: /built on/i }))
    expect(screen.getByTestId('built-on-account')).toBeTruthy()
    expect(screen.queryByTestId('edit-details-form')).toBeNull()
  })

  it('does not hand an editor the form they did not ask for', async () => {
    // The old sheet stacked BOTH: three paragraphs of account, then the form
    // below the fold. Whichever errand you were on, you got the other one first.
    renderHeader(viewResponse({
      access: OWNER_ACCESS,
      dataSourceId: 'ds_1',
      dataSourceName: 'Production Warehouse',
    }))
    fireEvent.click(await screen.findByRole('button', { name: /built on/i }))
    expect(screen.getByTestId('built-on-account')).toBeTruthy()
    expect(screen.queryByTestId('edit-details-form')).toBeNull()
    // …and it is one click away, not one scroll.
    fireEvent.click(screen.getByRole('tab', { name: 'Edit' }))
    expect(screen.getByTestId('edit-details-form')).toBeTruthy()
  })
})

describe('the details sheet is two errands, and the affordance picks one', () => {
  const WITH_SOURCE: Partial<View> = {
    access: OWNER_ACCESS,
    dataSourceId: 'ds_1',
    dataSourceName: 'Production Warehouse',
  }

  it('opens on Edit from the pencil — Name and the rest, with nothing above them', async () => {
    renderHeader(viewResponse(WITH_SOURCE))
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
    expect(screen.getByRole('tab', { name: 'Edit' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('edit-details-form')).toBeTruthy()
    expect(screen.queryByTestId('built-on-account')).toBeNull()
  })

  it('opens on About from the data source — the question it answers', async () => {
    renderHeader(viewResponse(WITH_SOURCE))
    fireEvent.click(await screen.findByRole('button', { name: /built on/i }))
    expect(screen.getByRole('tab', { name: 'About' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('built-on-account')).toBeTruthy()
  })

  it('wires each tab to the panel the way a screen reader needs', async () => {
    renderHeader(viewResponse(WITH_SOURCE))
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
    const tablist = screen.getByRole('tablist', { name: 'View details sections' })
    const [about, edit] = within(tablist).getAllByRole('tab')
    expect(edit.getAttribute('aria-selected')).toBe('true')
    // Roving tabindex: the strip is ONE tab stop, walked with the arrow keys.
    expect(about.getAttribute('tabindex')).toBe('-1')
    expect(edit.getAttribute('tabindex')).toBe('0')
    const panel = screen.getByRole('tabpanel')
    expect(edit.getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.getAttribute('aria-labelledby')).toBe(edit.id)
  })

  it('walks the strip with the arrow keys, selection following focus', async () => {
    renderHeader(viewResponse(WITH_SOURCE))
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Edit' }), { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: 'About' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('built-on-account')).toBeTruthy()
  })

  it('offers a viewer no strip at all — one errand is not a choice', async () => {
    renderHeader(viewResponse({ ...WITH_SOURCE, access: VIEWER_ACCESS }))
    fireEvent.click(await screen.findByRole('button', { name: /built on/i }))
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByTestId('built-on-account')).toBeTruthy()
    expect(screen.queryByTestId('edit-details-form')).toBeNull()
  })

  it('puts the cursor in Name when opening the editor was the point', async () => {
    renderHeader(viewResponse(WITH_SOURCE))
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
    expect(editPanelProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ autoFocusName: true }),
    )
  })

  it('does NOT take focus when Edit was merely arrowed onto', async () => {
    // Measured live: the form's autofocus fired after the tab took focus and
    // pulled the caret into the Name field, so the tab strip lost focus after
    // ONE arrow press and the reader could not arrow back to About.
    renderHeader(viewResponse(WITH_SOURCE))
    fireEvent.click(await screen.findByRole('button', { name: /built on/i }))
    fireEvent.keyDown(screen.getByRole('tab', { name: 'About' }), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Edit' }).getAttribute('aria-selected')).toBe('true')
    expect(editPanelProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ autoFocusName: false }),
    )
  })

  it('lets the tab that already says "Edit" be the only thing that says it', async () => {
    renderHeader(viewResponse(WITH_SOURCE))
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
    expect(editPanelProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ hideHeading: true }),
    )
  })

  it('closes on Escape, like any other dialog', async () => {
    renderHeader(viewResponse(WITH_SOURCE))
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('what the duplicated canvas title block left behind', () => {
  it('reads the entity-type count as a fact on the identity line', async () => {
    // It used to be the canvas toolbar's subtitle ("2 types · Context View"),
    // under a second copy of the name. The count is a fact about the view, so
    // it sits with the other facts — beside the KIND of view it qualifies.
    renderHeader(viewResponse({
      access: OWNER_ACCESS,
      config: { content: { visibleEntityTypes: ['table', 'column'] } },
    }))
    const chip = await screen.findByText('2 types')
    expect(chip.getAttribute('title')).toMatch(/shows 2 entity types/i)
  })

  it('says "1 type", not "1 types"', async () => {
    renderHeader(viewResponse({
      access: OWNER_ACCESS,
      config: { content: { visibleEntityTypes: ['table'] } },
    }))
    expect(await screen.findByText('1 type')).toBeInTheDocument()
  })

  it('prints no count at all when the view scopes none', async () => {
    renderHeader(viewResponse({ access: OWNER_ACCESS, config: { content: { visibleEntityTypes: [] } } }))
    await screen.findByText('Test View')
    expect(screen.queryByText(/\d+ types?$/)).toBeNull()
  })

  it('renames on double-click, the shortcut that came with the name', async () => {
    mockUpdateView.mockResolvedValue(viewResponse({ access: OWNER_ACCESS, name: 'Renamed' }))
    renderHeader(viewResponse({ access: OWNER_ACCESS }))

    const title = await screen.findByText('Test View')
    expect(title.getAttribute('title')).toBe('Double-click to rename')
    fireEvent.doubleClick(title)

    const input = screen.getByRole('textbox', { name: 'View name' })
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mockUpdateView).toHaveBeenCalledWith('view_1', { name: 'Renamed' })
  })

  it('cancels on Escape, and persists nothing', async () => {
    renderHeader(viewResponse({ access: OWNER_ACCESS }))
    fireEvent.doubleClick(await screen.findByText('Test View'))

    const input = screen.getByRole('textbox', { name: 'View name' })
    fireEvent.change(input, { target: { value: 'Discarded' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByRole('textbox', { name: 'View name' })).toBeNull()
    expect(mockUpdateView).not.toHaveBeenCalled()
    expect(screen.getByText('Test View')).toBeInTheDocument()
  })

  it('offers no rename to someone who cannot edit the view, but still spells the name out', async () => {
    // The name truncates. Without a title a viewer has no way to read a long
    // one at all — the old title block gave them exactly this fallback.
    renderHeader(viewResponse({ access: VIEWER_ACCESS }))
    const title = await screen.findByText('Test View')
    expect(title.getAttribute('title')).toBe('Test View')
    fireEvent.doubleClick(title)
    expect(screen.queryByRole('textbox', { name: 'View name' })).toBeNull()
  })
})

describe('the provenance footer, brought over from the canvas Edit-details dialog', () => {
  const MADE = { createdByName: 'Ada Lovelace', createdAt: '2026-01-01T00:00:00Z' }

  it('says who made this view, inside the details sheet', async () => {
    renderHeader(viewResponse({ access: OWNER_ACCESS, ...MADE }))
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
    expect(screen.getByText(/Created by Ada Lovelace/)).toBeInTheDocument()
  })

  it('adds who last edited it, once anyone has', async () => {
    renderHeader(viewResponse({
      access: OWNER_ACCESS, ...MADE,
      updatedBy: 'usr_grace', updatedByName: 'Grace Hopper',
      updatedAt: '2026-02-02T00:00:00Z',
    }))
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
    expect(screen.getByText(/Last edited by Grace Hopper/)).toBeInTheDocument()
  })

  it('says nothing about editing a view nobody has edited', async () => {
    renderHeader(viewResponse({ access: OWNER_ACCESS, ...MADE }))
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
    expect(screen.queryByText(/Last edited by/)).toBeNull()
  })

  it('reaches a viewer, who never had the edit-gated dialog it came from', async () => {
    // No Details button for them — the data source opens the same sheet, and
    // the footer sits outside the form's edit gate.
    renderHeader(viewResponse({
      access: VIEWER_ACCESS, ...MADE,
      dataSourceId: 'ds_1', dataSourceName: 'Nexus Lineage',
    }))
    fireEvent.click(await screen.findByRole('button', { name: /what this view is built on/i }))
    expect(screen.getByText(/Created by Ada Lovelace/)).toBeInTheDocument()
    expect(screen.queryByTestId('edit-details-form')).toBeNull()
  })
})

describe('Reviews, relocated from the versioning band', () => {
  it('joins Details and Activity in the header cluster', async () => {
    renderHeader(viewResponse({ access: OWNER_ACCESS }))
    expect(await screen.findByRole('button', { name: 'Reviews' })).toBeInTheDocument()
  })

  it('is withheld from a read-only session, which gets no versioning chrome at all', async () => {
    // CanvasRouter mounts no versioning bar for a read-only capability
    // session, so there would be nothing on the other end of the request.
    renderHeader(viewResponse({ access: VIEWER_ACCESS }))
    await screen.findByText('Test View')
    expect(screen.queryByRole('button', { name: 'Reviews' })).toBeNull()
  })
})
