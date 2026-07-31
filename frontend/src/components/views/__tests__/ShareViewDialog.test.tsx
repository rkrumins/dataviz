/**
 * ShareViewDialog capability + regression pins:
 *   - selected tiles carry LITERAL accent classes (the interpolated
 *     `border-${accent}-500` strings were invisible to Tailwind's JIT,
 *     so selection never colored);
 *   - the enterprise tile disables without the publish capability;
 *   - without canManageGrants the grants list is never fetched and a
 *     locked note renders instead of an error box;
 *   - the people picker searches the signed-in directory, never the
 *     admin listing;
 *   - a grant's role is editable in place.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/viewApiService', async () => {
  const actual = await vi.importActual<typeof import('@/services/viewApiService')>(
    '@/services/viewApiService',
  )
  return { ...actual, updateViewVisibility: vi.fn() }
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
}))
vi.mock('@/store/branding', () => ({
  useBrand: () => ({ appName: 'TestBrand' }),
}))

import { ShareViewDialog } from '../ShareViewDialog'
import { viewGrantsService } from '@/services/viewGrantsService'
import { searchDirectory } from '@/services/userDirectoryService'
import type { ViewAccess } from '@/services/viewApiService'

const mockList = vi.mocked(viewGrantsService.list)
const mockUpdate = vi.mocked(viewGrantsService.update)
const mockSearch = vi.mocked(searchDirectory)

const MANAGER_ACCESS: ViewAccess = {
  canEdit: true,
  canManageGrants: true,
  canChangeVisibility: true,
  canPublish: false,
  accessVia: 'owner',
  dataAccess: 'full',
}

const VIEWER_ACCESS: ViewAccess = {
  canEdit: false,
  canManageGrants: false,
  canChangeVisibility: false,
  canPublish: false,
  accessVia: 'enterprise',
  dataAccess: 'readonly',
}

const GRANT = {
  grantId: 'grant_1',
  role: 'viewer' as const,
  grantedAt: '2026-01-01T00:00:00Z',
  grantedBy: 'usr_owner',
  subject: { type: 'user' as const, id: 'usr_x', displayName: 'Xavier', secondary: 'x@example.com' },
}

function renderDialog(access: ViewAccess) {
  return render(
    <ShareViewDialog
      viewId="view_1"
      viewName="Test View"
      currentVisibility="workspace"
      workspaceId="ws_1"
      access={access}
      isOpen={true}
      onClose={() => {}}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockList.mockResolvedValue([GRANT])
  mockSearch.mockResolvedValue({ users: [], groups: [] })
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
