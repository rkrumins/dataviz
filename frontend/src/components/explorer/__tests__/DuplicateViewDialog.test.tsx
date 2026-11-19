/**
 * Duplicate, from a view card's menu: a proper copy, made by the server.
 *
 *   - The dialog starts at "Copy of <name>", seen by only you, and says what the copy will be for
 *     each kind of view: an ordinary view's layout, a view made from a query made again from its
 *     query, a subset with its search.
 *   - It asks `POST /api/v1/views/{id}/duplicate` with the name and who can see it, then opens the
 *     copy, and reads the view lists again.
 *   - A copy the server refuses (403, 404, 422) is said in plain words, and the dialog stays.
 *   - viewService.duplicateView goes through the same route.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const notify = vi.fn()
const navigateMock = vi.fn()
const authFetchMock = vi.fn()

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
}))
vi.mock('@/services/apiClient', () => ({ authFetch: (...a: unknown[]) => authFetchMock(...a) }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/components/views/ViewActivityDrawer', () => ({ ViewActivityDrawer: () => null }))
vi.mock('@/store/branding', () => ({ useBrand: () => ({ appName: 'TestBrand' }) }))
vi.mock('@/features/view-versions/ViewVersionsDrawer', () => ({ ViewVersionsDrawer: () => null }))
vi.mock('@/features/view-transfer/ExportViewDialog', () => ({ ExportViewDialog: () => null }))
vi.mock('@/hooks/usePublishGate', () => ({
  usePublishGate: () => ({ canPublish: true, canRequestPublish: false, restrictedSource: false, blockedBy: null, enterpriseAvailable: true }),
}))

import { queryClient } from '@/lib/queryClient'
import { viewService } from '@/services/viewService'
import type { MadeFrom } from '../madeFrom'
import { ViewCardOverflowMenu } from '../ViewCardOverflowMenu'

const COPY = { id: 'view_copy', name: 'Copy of Payments', workspaceId: 'ws_1', viewType: 'reference', config: {}, visibility: 'private' }

function refusal(status: number, message: string) {
  return Object.assign(new Error(message), { status })
}

function openDuplicate(madeFrom: MadeFrom | null = null) {
  render(
    <MemoryRouter>
      <ViewCardOverflowMenu viewId="v1" viewName="Payments" visibility="workspace" workspaceId="ws_1"
        onDelete={vi.fn()} onShare={vi.fn()} madeFrom={madeFrom} />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button'))
  fireEvent.click(screen.getByText('Duplicate…'))
  return screen.getByRole('dialog')
}

function sent() {
  const [url, init] = authFetchMock.mock.calls[0]
  return { url, method: init.method, body: JSON.parse(init.body) }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Duplicate — a proper copy of any view', () => {
  it('copies an ordinary view as “Copy of …”, seen only by you, then opens the copy', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    authFetchMock.mockResolvedValue({ view: COPY })
    openDuplicate()

    expect(screen.getByDisplayValue('Copy of Payments')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Private/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(/starts with this view’s layers, placements and settings/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Duplicate$/ }))

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/views/view_copy'))
    expect(sent()).toEqual({ url: '/api/v1/views/v1/duplicate', method: 'POST', body: { name: 'Copy of Payments', visibility: 'private' } })
    expect(notify).toHaveBeenCalledWith('success', '“Copy of Payments” made')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['explorer-views'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['views'] })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('makes a view made from a query again from its query, named and shared as chosen', async () => {
    authFetchMock.mockResolvedValue({ view: { ...COPY, name: 'Payments for UAT' }, membership: { status: 'updating' } })
    openDuplicate({ kind: 'query', mode: 'live' })

    expect(screen.getByText(/made from the same query and layers\. Its members are worked out afresh/)).toBeInTheDocument()
    fireEvent.change(screen.getByDisplayValue('Copy of Payments'), { target: { value: '  Payments for UAT ' } })
    fireEvent.click(screen.getByRole('radio', { name: /Workspace/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Duplicate$/ }))

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/views/view_copy'))
    expect(sent().body).toEqual({ name: 'Payments for UAT', visibility: 'workspace' })
    expect(notify).toHaveBeenCalledWith('success', '“Payments for UAT” made — working out its members')
  })

  it('copies a subset with its search', async () => {
    authFetchMock.mockResolvedValue({ view: COPY })
    openDuplicate({ kind: 'subset' })

    expect(screen.getByText(/keeps its search/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Duplicate$/ }))
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/views/view_copy'))
    expect(sent()).toEqual({ url: '/api/v1/views/v1/duplicate', method: 'POST', body: { name: 'Copy of Payments', visibility: 'private' } })
  })

  it.each([
    [403, 'workspace:view:create required', 'You can’t make views where this one lives, so it can’t be copied there.'],
    [404, 'View not found', 'This view is gone, or you can no longer open it.'],
    [422, 'Its base view is gone, so a copy would show nothing.', 'Its base view is gone, so a copy would show nothing.'],
  ])('says a %i refusal in plain words, and stays', async (status, message, words) => {
    authFetchMock.mockRejectedValue(refusal(status, message))
    openDuplicate()
    fireEvent.click(screen.getByRole('button', { name: /^Duplicate$/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(words)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(navigateMock).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /^Duplicate$/ })).not.toBeDisabled()
  })

  it('asks for no copy without a name', () => {
    openDuplicate()
    fireEvent.change(screen.getByDisplayValue('Copy of Payments'), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: /^Duplicate$/ })).toBeDisabled()
  })
})

describe('viewService.duplicateView', () => {
  it('goes through the same route, and says a refusal the same way', async () => {
    authFetchMock.mockResolvedValueOnce({ view: COPY })
    const made = await viewService.duplicateView('v1', { name: 'Copy of Payments' })
    expect(made).toMatchObject({ success: true, data: { id: 'view_copy', name: 'Copy of Payments' } })
    expect(sent()).toEqual({ url: '/api/v1/views/v1/duplicate', method: 'POST', body: { name: 'Copy of Payments' } })

    authFetchMock.mockRejectedValueOnce(refusal(404, 'View not found'))
    expect(await viewService.duplicateView('v_gone')).toEqual({
      success: false, error: 'This view is gone, or you can no longer open it.',
    })
  })
})
