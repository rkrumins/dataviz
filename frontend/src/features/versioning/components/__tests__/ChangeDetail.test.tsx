/**
 * ChangeDetail — one change in full, read on its own when shown: an added entity with the values it
 * was added with, a modified one field by field before → after, a deleted one with what it held and
 * Deletion details.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ getChangeEntry: vi.fn() }))
vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()),
  ...api,
}))

import { ChangeDetail } from '../ChangeDetail'

const origin = { branchId: 'br_1' }
function renderDetail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ChangeDetail wsId="ws1" graphId="g1" origin={origin} entityId="e1" label="orders" />
    </QueryClientProvider>,
  )
}

beforeEach(() => { api.getChangeEntry.mockReset() })

describe('ChangeDetail', () => {
  it('shows what an added entity was added with', async () => {
    api.getChangeEntry.mockResolvedValue({ entityId: 'e1', kind: 'node', status: 'added', before: null,
      after: { displayName: 'orders', owner: 'sales' } })
    renderDetail()
    expect(await screen.findByText('sales')).toBeInTheDocument()
    expect(api.getChangeEntry).toHaveBeenCalledWith('ws1', 'g1', origin, 'e1')
  })

  it('shows each field of a modified entity, before and after', async () => {
    api.getChangeEntry.mockResolvedValue({ entityId: 'e1', kind: 'node', status: 'modified',
      before: { displayName: 'orders', owner: 'finance' }, after: { displayName: 'orders', owner: 'sales' } })
    renderDetail()
    expect(await screen.findByText('finance')).toBeInTheDocument()
    expect(screen.getByText('sales')).toBeInTheDocument()
    expect(screen.queryByText('displayName')).toBeNull()                       // unchanged fields aren't listed
  })

  it('shows what a deleted entity held, with its deletion details', async () => {
    api.getChangeEntry.mockResolvedValue({ entityId: 'e1', kind: 'node', status: 'removed',
      before: { displayName: 'orders', owner: 'finance' }, after: null })
    renderDetail()
    expect(await screen.findByText('finance')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Deletion details/ })).toBeInTheDocument()
  })

  it('says when it could not load the change', async () => {
    api.getChangeEntry.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }))
    renderDetail()
    expect(await screen.findByText("Couldn't load this change.")).toBeInTheDocument()
  })
})
