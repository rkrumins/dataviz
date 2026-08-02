/**
 * ViewPageHeader pins:
 *   - a pending publication request is visible ON the view, naming who
 *     asked and when (it used to live only in the admin queue and inside
 *     the Share dialog, so the view itself said nothing);
 *   - it is only a BUTTON — a route into the dialog where approve/decline
 *     live — for a caller who can actually answer it; everyone else gets
 *     a read-only badge;
 *   - no request, no badge.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/viewApiService', async () => {
  const actual = await vi.importActual<typeof import('@/services/viewApiService')>(
    '@/services/viewApiService',
  )
  return { ...actual, getView: vi.fn() }
})
vi.mock('@/store/schema', () => ({
  useSchemaStore: (selector: (s: unknown) => unknown) => selector({ updateView: vi.fn() }),
}))
// The panels are exercised by their own suites; here they are noise.
vi.mock('@/components/views/EditDetailsPanel', () => ({ EditDetailsPanel: () => null }))
vi.mock('@/components/views/ViewActivityDrawer', () => ({ ViewActivityDrawer: () => null }))
vi.mock('@/components/views/ShareViewDialog', () => ({
  ShareViewDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="share-dialog" /> : null,
}))

import { ViewPageHeader } from '../ViewPageHeader'
import {
  getView,
  type View,
  type ViewAccess,
  type ViewPublishRequest,
} from '@/services/viewApiService'

const mockGetView = vi.mocked(getView)

const OWNER_ACCESS: ViewAccess = {
  canEdit: true,
  canManageGrants: true,
  canChangeVisibility: true,
  canPublish: false,
  canRequestPublish: true,
  accessVia: 'owner',
  dataAccess: 'full',
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

function renderHeader(view: View) {
  mockGetView.mockResolvedValue(view)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ViewPageHeader viewId="view_1" workspaceName="Finance" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
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
