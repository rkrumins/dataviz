/**
 * EditViewDetailsDialog — RTL tests.
 *
 * On open the dialog fetches the full view (the in-store ViewConfiguration
 * lacks description/tags) and seeds name/description/tags. Save persists via
 * viewApiService.updateView, notifies onSaved, and closes. A save failure
 * keeps the dialog open with fields intact and surfaces the server detail as
 * an error notification; a fetch failure notifies + closes. Cancel never persists.
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const notify = vi.fn()
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))

const getViewMock = vi.fn()
const updateViewMock = vi.fn()
vi.mock('@/services/viewApiService', () => ({
  getView: (...args: unknown[]) => getViewMock(...args),
  updateView: (...args: unknown[]) => updateViewMock(...args),
}))

import { EditViewDetailsDialog } from '../EditViewDetailsDialog'

const seededView = {
  id: 'v1',
  name: 'Data Landscape',
  description: 'A map of the estate',
  tags: ['finance', 'core'],
  workspaceId: 'ws1',
  viewType: 'graph',
  config: {},
  visibility: 'workspace',
  isPinned: false,
  favouriteCount: 0,
  isFavourited: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('EditViewDetailsDialog — fetch on open', () => {
  it('shows a loading state, then seeds fields from getView', async () => {
    let resolve!: (v: unknown) => void
    getViewMock.mockReturnValue(new Promise(r => { resolve = r }))

    render(<EditViewDetailsDialog open viewId="v1" onClose={vi.fn()} onSaved={vi.fn()} />)

    expect(getViewMock).toHaveBeenCalledWith('v1')
    expect(screen.getByText(/loading/i)).toBeInTheDocument()

    await act(async () => { resolve(seededView) })

    expect(screen.getByLabelText('Name')).toHaveValue('Data Landscape')
    expect(screen.getByLabelText('Description')).toHaveValue('A map of the estate')
    expect(screen.getByLabelText('Tags')).toHaveValue('finance, core')
  })

  it('notifies and closes when the fetch fails', async () => {
    getViewMock.mockRejectedValue(new Error('View not found'))
    const onClose = vi.fn()

    render(<EditViewDetailsDialog open viewId="v1" onClose={onClose} onSaved={vi.fn()} />)

    await waitFor(() => expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('View not found')))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('EditViewDetailsDialog — save', () => {
  it('persists the edited fields, notifies onSaved, and closes', async () => {
    getViewMock.mockResolvedValue(seededView)
    updateViewMock.mockResolvedValue({ ...seededView, name: 'New name' })
    const onSaved = vi.fn()
    const onClose = vi.fn()

    render(<EditViewDetailsDialog open viewId="v1" onClose={onClose} onSaved={onSaved} />)

    const name = await screen.findByLabelText('Name')
    fireEvent.change(name, { target: { value: 'New name' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(updateViewMock).toHaveBeenCalledWith('v1', {
      name: 'New name',
      description: 'A map of the estate',
      tags: ['finance', 'core'],
    }))
    expect(onSaved).toHaveBeenCalledWith({
      name: 'New name',
      description: 'A map of the estate',
      tags: ['finance', 'core'],
    })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('keeps the dialog open with fields intact and notifies the server detail on failure', async () => {
    getViewMock.mockResolvedValue(seededView)
    updateViewMock.mockRejectedValue(new Error('Forbidden — you can no longer edit this view'))
    const onSaved = vi.fn()
    const onClose = vi.fn()

    render(<EditViewDetailsDialog open viewId="v1" onClose={onClose} onSaved={onSaved} />)

    const name = await screen.findByLabelText('Name')
    fireEvent.change(name, { target: { value: 'New name' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('Forbidden')))
    expect(onSaved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Name')).toHaveValue('New name')
  })

  it('cancels without calling updateView', async () => {
    getViewMock.mockResolvedValue(seededView)
    const onClose = vi.fn()

    render(<EditViewDetailsDialog open viewId="v1" onClose={onClose} onSaved={vi.fn()} />)

    await screen.findByLabelText('Name')
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(updateViewMock).not.toHaveBeenCalled()
  })
})

describe('EditViewDetailsDialog — provenance footer', () => {
  it('shows the resolved creator name and omits the last-edited line when the view has never been edited', async () => {
    getViewMock.mockResolvedValue({
      ...seededView,
      createdByName: 'Ada Lovelace',
      updatedBy: null,
      updatedByName: null,
    })

    render(<EditViewDetailsDialog open viewId="v1" onClose={vi.fn()} onSaved={vi.fn()} />)

    await screen.findByLabelText('Name')
    expect(screen.getByText(/Created by Ada Lovelace/)).toBeInTheDocument()
    expect(screen.queryByText(/Last edited by/)).not.toBeInTheDocument()
  })

  it('falls back to "Unknown" for an unresolvable creator name — never the raw id', async () => {
    getViewMock.mockResolvedValue({
      ...seededView,
      createdByName: null,
      updatedBy: null,
    })

    render(<EditViewDetailsDialog open viewId="v1" onClose={vi.fn()} onSaved={vi.fn()} />)

    await screen.findByLabelText('Name')
    expect(screen.getByText(/Created by Unknown/)).toBeInTheDocument()
  })

  it('shows a resolved last-edited name and date once the view has been edited', async () => {
    getViewMock.mockResolvedValue({
      ...seededView,
      createdByName: 'Ada Lovelace',
      updatedBy: 'usr_2',
      updatedByName: 'Grace Hopper',
      updatedAt: '2026-02-01T00:00:00Z',
    })

    render(<EditViewDetailsDialog open viewId="v1" onClose={vi.fn()} onSaved={vi.fn()} />)

    await screen.findByLabelText('Name')
    expect(screen.getByText(/Last edited by Grace Hopper/)).toBeInTheDocument()
  })

  it('falls back to "Unknown" for an unresolvable editor name — never the raw id', async () => {
    getViewMock.mockResolvedValue({
      ...seededView,
      updatedBy: 'usr_2',
      updatedByName: null,
    })

    render(<EditViewDetailsDialog open viewId="v1" onClose={vi.fn()} onSaved={vi.fn()} />)

    await screen.findByLabelText('Name')
    expect(screen.getByText(/Last edited by Unknown/)).toBeInTheDocument()
  })
})
