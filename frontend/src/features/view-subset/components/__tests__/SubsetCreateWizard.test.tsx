/**
 * SubsetCreateWizard — name it, choose who sees it, review, make it.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  createSubsetView: vi.fn(),
  requestViewPublication: vi.fn(),
}))
vi.mock('@/services/viewApiService', async (original) => ({
  ...(await original<typeof import('@/services/viewApiService')>()),
  createSubsetView: api.createSubsetView,
  requestViewPublication: api.requestViewPublication,
}))
const gate = vi.hoisted(() => ({ current: { canPublish: true, canRequestPublish: false, restrictedSource: false, blockedBy: null, enterpriseAvailable: true } }))
vi.mock('@/hooks/usePublishGate', () => ({ usePublishGate: () => gate.current }))
vi.mock('@/hooks/useViewAudience', () => ({ useViewAudience: () => ({}) }))

import type { LineageBridgesState } from '../../hooks/useLineageBridges'
import { useSubsetStudioStore, type SubsetPick } from '../../model/studioStore'
import { SubsetCreateWizard } from '../SubsetCreateWizard'

const layers = [{ id: 'raw', name: 'Raw' }, { id: 'marts', name: 'Marts' }]
const pick = (urn: string, layerId: string, over: Partial<SubsetPick> = {}): SubsetPick =>
  ({ urn, layerId, inheritsChildren: true, origin: 'picked', label: urn.toUpperCase(), ...over })
const preview: LineageBridgesState = {
  status: 'ready', links: [{ source: 'a', target: 'f', hops: 3 }], incomplete: [], depthLimited: false,
  isFetching: false, refetch: vi.fn(),
}
const created = {
  id: 'view_new', name: 'Finance lineage — subset', workspaceId: 'ws', viewType: 'reference', config: {},
  visibility: 'private', isPinned: false, favouriteCount: 0, isFavourited: false, createdAt: '', updatedAt: '',
}

function renderWizard(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <SubsetCreateWizard
          source={{ id: 'view_src', name: 'Finance lineage', workspaceId: 'ws', workspaceName: 'Finance' }}
          layers={layers}
          preview={preview}
          onClose={onClose}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  )
  return { onClose }
}

beforeEach(() => {
  sessionStorage.clear()
  api.createSubsetView.mockReset().mockResolvedValue(created)
  api.requestViewPublication.mockReset().mockResolvedValue(created)
  gate.current = { canPublish: true, canRequestPublish: false, restrictedSource: false, blockedBy: null, enterpriseAvailable: true }
  act(() => {
    useSubsetStudioStore.getState().open('view_src')
    useSubsetStudioStore.getState().add([
      pick('a', 'raw', { logicalNodeId: 'g1' }),
      pick('f', 'marts', { inheritsChildren: false }),
    ], 'seed')
    useSubsetStudioStore.getState().setMaxHops(6)
  })
})
afterEach(() => { act(() => useSubsetStudioStore.getState().close({ discard: true })) })

describe('SubsetCreateWizard', () => {
  it('starts from a sensible name and will not go on without one', () => {
    renderWizard()
    const name = screen.getByLabelText('Name') as HTMLInputElement
    expect(name.value).toBe('Finance lineage — subset')
    fireEvent.change(name, { target: { value: '   ' } })
    expect(screen.getByText('Give the subset a name')).toBeTruthy()
    expect((screen.getByRole('button', { name: /Next/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('reviews what the subset will hold, and says what a subset does not do', async () => {
    renderWizard()
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    const held = await screen.findByRole('region', { name: 'Layers in the subset' })
    expect(held.textContent).toContain('Raw')
    expect(held.textContent).toContain('Marts')
    expect(screen.getByText(/narrows what people see, not what they can open/)).toBeTruthy()
    expect(screen.getByText(/up to\s+6 steps long/)).toBeTruthy()
  })

  it('makes the view in one write, from the picks, and hands over to it', async () => {
    const { onClose } = renderWizard()
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: 'For finance' } })
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    fireEvent.click(screen.getByRole('button', { name: /Create subset/ }))
    await screen.findByText('Your view is ready')
    expect(api.createSubsetView).toHaveBeenCalledWith('view_src', {
      name: 'Finance lineage — subset',
      description: 'For finance',
      visibility: 'private',
      members: [
        { urn: 'a', layerId: 'raw', logicalNodeId: 'g1', inheritsChildren: true },
        { urn: 'f', layerId: 'marts', inheritsChildren: false },
      ],
      connectivity: { mode: 'bridged', maxHops: 6 },
    })
    // The picks became a view: the studio is done with them.
    expect(useSubsetStudioStore.getState().sourceViewId).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Stay here' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('leaves groups behind when the reader chose to', async () => {
    act(() => useSubsetStudioStore.getState().setKeepGroups(false))
    renderWizard()
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    fireEvent.click(screen.getByRole('button', { name: /Create subset/ }))
    await screen.findByText('Your view is ready')
    expect(api.createSubsetView.mock.calls[0][1].members[0]).toEqual({ urn: 'a', layerId: 'raw', inheritsChildren: true })
  })

  it('asks for publication rather than failing when the reader cannot publish', async () => {
    gate.current = { ...gate.current, canPublish: false, canRequestPublish: true, blockedBy: 'workspace' as never }
    renderWizard()
    fireEvent.click(screen.getByRole('radio', { name: /^Enterprise/ }))
    fireEvent.change(screen.getByLabelText(/Note for your admin/), { target: { value: 'quarterly' } })
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    fireEvent.click(screen.getByRole('button', { name: /Create subset/ }))
    await screen.findByText('Your view is ready')
    expect(api.createSubsetView.mock.calls[0][1].visibility).toBe('workspace')
    expect(api.requestViewPublication).toHaveBeenCalledWith('view_new', 'quarterly')
  })

  it('offers a retry when the write fails, and never loses the picks', async () => {
    api.createSubsetView.mockRejectedValueOnce(new Error('The source view\'s layers changed'))
    renderWizard()
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    fireEvent.click(screen.getByRole('button', { name: /Create subset/ }))
    expect(await screen.findByText(/layers changed/)).toBeTruthy()
    expect(useSubsetStudioStore.getState().order).toEqual(['a', 'f'])
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(screen.getByText('Your view is ready')).toBeTruthy())
  })
})
