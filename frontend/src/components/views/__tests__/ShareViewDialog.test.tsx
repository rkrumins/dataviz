/**
 * ShareViewDialog capability + regression pins:
 *   - selected tiles carry LITERAL accent classes (the interpolated
 *     `border-${accent}-500` strings were invisible to Tailwind's JIT,
 *     so selection never colored);
 *   - the enterprise tile disables without the publish capability, but
 *     becomes a REQUEST route when the caller may ask for one;
 *   - a pending request renders as state, with the actions each side is
 *     allowed to take;
 *   - without canManageGrants the grants list is never fetched and a
 *     locked note renders instead of an error box;
 *   - the people picker searches the signed-in directory, never the
 *     admin listing;
 *   - a grant's role is editable in place.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/viewApiService', async () => {
  const actual = await vi.importActual<typeof import('@/services/viewApiService')>(
    '@/services/viewApiService',
  )
  return {
    ...actual,
    getView: vi.fn(),
    updateViewVisibility: vi.fn(),
    requestViewPublication: vi.fn(),
    withdrawViewPublicationRequest: vi.fn(),
    approveViewPublication: vi.fn(),
    denyViewPublication: vi.fn(),
  }
})
vi.mock('@/services/viewGrantsService', () => ({
  viewGrantsService: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}))
vi.mock('@/services/userDirectoryService', () => ({
  searchDirectory: vi.fn(),
}))
vi.mock('@/store/auth', () => ({
  usePermission: vi.fn().mockReturnValue(false),
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ user: { id: 'usr_me' } }),
}))
vi.mock('@/store/branding', () => ({
  useBrand: () => ({ appName: 'TestBrand' }),
}))

import { ShareViewDialog } from '../ShareViewDialog'
import { viewGrantsService } from '@/services/viewGrantsService'
import { searchDirectory } from '@/services/userDirectoryService'
import {
  approveViewPublication,
  denyViewPublication,
  getView,
  requestViewPublication,
  updateViewVisibility,
  type View,
  type ViewAccess,
  type ViewPublishRequest,
} from '@/services/viewApiService'
import type { ViewVisibility } from '@/lib/viewVisibility'

const mockList = vi.mocked(viewGrantsService.list)
const mockUpdate = vi.mocked(viewGrantsService.update)
const mockSearch = vi.mocked(searchDirectory)
const mockGetView = vi.mocked(getView)
const mockSetVisibility = vi.mocked(updateViewVisibility)
const mockRequestPublication = vi.mocked(requestViewPublication)
const mockApprove = vi.mocked(approveViewPublication)
const mockDeny = vi.mocked(denyViewPublication)

const MANAGER_ACCESS: ViewAccess = {
  canEdit: true,
  canManageGrants: true,
  canChangeVisibility: true,
  canPublish: false,
  accessVia: 'owner',
  dataAccess: 'full',
}

/** Owns the view's sharing settings but not the publish permission — the
 *  case the whole request journey exists for. */
const REQUESTER_ACCESS: ViewAccess = {
  ...MANAGER_ACCESS,
  canRequestPublish: true,
}

/** Holds the publish permission, so answers other people's requests. */
const ANSWERER_ACCESS: ViewAccess = {
  ...MANAGER_ACCESS,
  canPublish: true,
  canAnswerPublishRequest: true,
}

const VIEWER_ACCESS: ViewAccess = {
  canEdit: false,
  canManageGrants: false,
  canChangeVisibility: false,
  canPublish: false,
  accessVia: 'enterprise',
  dataAccess: 'readonly',
}

const PENDING: ViewPublishRequest = {
  requestedBy: 'usr_me',
  requestedByName: 'Ada Lovelace',
  requestedAt: '2026-01-01T00:00:00Z',
  note: 'The whole company needs this map.',
}

const GRANT = {
  grantId: 'grant_1',
  role: 'viewer' as const,
  grantedAt: '2026-01-01T00:00:00Z',
  grantedBy: 'usr_owner',
  subject: { type: 'user' as const, id: 'usr_x', displayName: 'Xavier', secondary: 'x@example.com' },
}

/** The minimum View the dialog reads out of a mutation response. */
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

function renderDialog(
  access: ViewAccess,
  publishRequest?: ViewPublishRequest | null,
  currentVisibility: ViewVisibility = 'workspace',
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ShareViewDialog
        viewId="view_1"
        viewName="Test View"
        currentVisibility={currentVisibility}
        workspaceId="ws_1"
        access={access}
        publishRequest={publishRequest}
        isOpen={true}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockList.mockResolvedValue([GRANT])
  mockSearch.mockResolvedValue({ users: [], groups: [] })
  mockGetView.mockResolvedValue(viewResponse())
})

describe('visibility tiles', () => {
  it('the selected tile carries a literal accent class', async () => {
    renderDialog(MANAGER_ACCESS)
    const workspaceTile = (await screen.findByText('Workspace')).closest('button')!
    expect(workspaceTile.className).toContain('border-sky-500')
    expect(workspaceTile.className).not.toContain('${')
  })

  it('enterprise disables without the publish capability, with the reason', async () => {
    renderDialog(MANAGER_ACCESS)
    const enterpriseTile = (await screen.findByText('Enterprise')).closest('button')!
    expect(enterpriseTile).toBeDisabled()
    expect(enterpriseTile.textContent).toMatch(/publish views/i)
  })
})

/** The audience sentence, addressed by its label — the visibility TILE
 *  names the same workspace in the same words, so a bare phrase match
 *  finds both. */
async function audienceLine(): Promise<HTMLElement> {
  const label = await screen.findByText(/Who can open this view:/)
  return label.parentElement as HTMLElement
}

describe('audience sentence', () => {
  /** The counts only ever come from the single-view read. */
  const withAudience = (over: Partial<View> = {}) =>
    mockGetView.mockResolvedValue(viewResponse({
      workspaceName: 'Finance',
      audience: { workspaceMemberCount: 12, explicitGrantCount: 2 },
      ...over,
    }))

  it('names the workspace, its size, and the explicit shares', async () => {
    withAudience()
    renderDialog(MANAGER_ACCESS, null, 'workspace')
    expect(
      (await audienceLine()).textContent,
    ).toContain("Everyone in Finance — 12 people — plus 2 you've shared with.")
  })

  it('counts the shares in the private sentence', async () => {
    withAudience()
    renderDialog(MANAGER_ACCESS, null, 'private')
    expect(
      await screen.findByText(/Only you, 2 people you've shared with, and workspace admins\./),
    ).toBeTruthy()
  })

  it('names the brand for the enterprise tier', async () => {
    withAudience()
    renderDialog(ANSWERER_ACCESS, null, 'enterprise')
    expect(
      await screen.findByText(/Anyone signed in to TestBrand, plus 2 you've shared with\./),
    ).toBeTruthy()
  })

  it('says "1 person", not "1 people"', async () => {
    withAudience({ audience: { workspaceMemberCount: 1, explicitGrantCount: 1 } })
    renderDialog(MANAGER_ACCESS, null, 'private')
    expect(
      await screen.findByText(/Only you, 1 person you've shared with, and workspace admins\./),
    ).toBeTruthy()
  })

  it('drops the clause rather than claiming zero shares', async () => {
    withAudience({ audience: { workspaceMemberCount: 12, explicitGrantCount: 0 } })
    renderDialog(MANAGER_ACCESS, null, 'workspace')
    const line = await audienceLine()
    expect(line.textContent).toContain('Everyone in Finance')
    expect(line.textContent).toContain('12 people')
    expect(line.textContent).not.toMatch(/shared with/)
  })

  it('degrades to an unnumbered sentence when the payload has no audience', async () => {
    mockGetView.mockResolvedValue(viewResponse({ workspaceName: 'Finance' }))
    renderDialog(MANAGER_ACCESS, null, 'workspace')
    const line = await audienceLine()
    expect(line.textContent).toContain('Everyone in Finance')
    // No audience means no counts — never a fabricated 0.
    expect(line.textContent).not.toMatch(/\d/)
  })
})

describe('publication requests', () => {
  it('picking enterprise with requiresApproval files a REQUEST, never a visibility write', async () => {
    mockRequestPublication.mockResolvedValue(viewResponse({ publishRequest: PENDING }))
    renderDialog(REQUESTER_ACCESS)

    const enterpriseTile = (await screen.findByText('Enterprise')).closest('button')!
    expect(enterpriseTile).not.toBeDisabled()
    expect(enterpriseTile.textContent).toMatch(/needs approval/i)
    fireEvent.click(enterpriseTile)

    const note = await screen.findByPlaceholderText(/why should everyone see this/i)
    fireEvent.change(note, { target: { value: 'Finance needs it' } })
    fireEvent.click(screen.getByText('Send request'))

    await waitFor(() =>
      expect(mockRequestPublication).toHaveBeenCalledWith('view_1', 'Finance needs it'),
    )
    expect(mockSetVisibility).not.toHaveBeenCalled()
    // The response's request state replaces the composer.
    expect(await screen.findByText(/awaiting approval/i)).toBeTruthy()
  })

  it('renders a pending request as state, with the requester able to withdraw', async () => {
    renderDialog(REQUESTER_ACCESS, PENDING)
    const banner = await screen.findByText(/publication requested by ada lovelace/i)
    expect(banner.textContent).toMatch(/awaiting approval/i)
    expect(screen.getByText(PENDING.note!)).toBeTruthy()
    expect(screen.getByText('Withdraw request')).toBeTruthy()
    // Nothing to approve — this caller cannot answer their own ask.
    expect(screen.queryByText('Approve')).toBeNull()
  })

  it('an answerer gets Approve / Decline, and Approve publishes through the endpoint', async () => {
    mockApprove.mockResolvedValue(viewResponse({ visibility: 'enterprise', publishRequest: null }))
    const onVisibilityChange = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <ShareViewDialog
          viewId="view_1"
          viewName="Test View"
          currentVisibility="workspace"
          workspaceId="ws_1"
          access={ANSWERER_ACCESS}
          publishRequest={PENDING}
          isOpen={true}
          onClose={() => {}}
          onVisibilityChange={onVisibilityChange}
        />
      </QueryClientProvider>,
    )

    const approve = await screen.findByText('Approve')
    expect(screen.getByText('Decline')).toBeTruthy()

    fireEvent.click(approve)
    await waitFor(() => expect(mockApprove).toHaveBeenCalledWith('view_1'))
    await waitFor(() => expect(onVisibilityChange).toHaveBeenCalledWith('enterprise'))
    // Answered — the pending banner is gone.
    expect(screen.queryByText(/awaiting approval/i)).toBeNull()
  })

  it('Decline asks for a reason before it fires', async () => {
    mockDeny.mockResolvedValue(viewResponse({ publishRequest: null }))
    renderDialog(ANSWERER_ACCESS, PENDING)

    fireEvent.click(await screen.findByText('Decline'))
    expect(mockDeny).not.toHaveBeenCalled()

    fireEvent.change(screen.getByPlaceholderText(/why not/i), {
      target: { value: 'Too narrow for everyone' },
    })
    fireEvent.click(screen.getByText('Confirm decline'))
    await waitFor(() =>
      expect(mockDeny).toHaveBeenCalledWith('view_1', 'Too narrow for everyone'),
    )
  })
})

describe('grants section gating', () => {
  it('never fetches grants for a caller who cannot manage them, and renders the locked note', async () => {
    renderDialog(VIEWER_ACCESS)
    expect(
      await screen.findByText(/only the view's owner or a workspace admin/i),
    ).toBeTruthy()
    expect(mockList).not.toHaveBeenCalled()
  })

  it('edits a grant role in place through the update endpoint', async () => {
    mockUpdate.mockResolvedValue({ ...GRANT, role: 'editor' })
    renderDialog(MANAGER_ACCESS)
    await screen.findByText('Xavier')
    const editorButton = screen
      .getAllByTitle('Make editor')
      .find(b => b.closest('div')?.textContent?.includes('Editor'))!
    fireEvent.click(editorButton)
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith('view_1', 'grant_1', 'editor'),
    )
  })
})

describe('people picker', () => {
  it('searches the signed-in directory (not the admin listing)', async () => {
    renderDialog(MANAGER_ACCESS)
    const input = await screen.findByPlaceholderText('Add a user…')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'ada' } })
    await waitFor(() =>
      expect(mockSearch).toHaveBeenCalledWith('ada', { types: ['user'], limit: 25 }),
    )
  })
})
