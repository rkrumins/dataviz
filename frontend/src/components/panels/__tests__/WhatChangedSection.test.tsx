/**
 * WhatChangedSection — a drawer's "What changed": for an entity or relationship the canvas's change
 * set holds, whether it was added or modified and where (a draft, or two revisions compared), then
 * each field, read by its entity id. An unchanged entity and a tombstone show nothing and ask for
 * nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ getChangeEntry: vi.fn() }))
vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()),
  ...api,
}))

import { useBranchStore } from '@/store/branchStore'
import { buildChangeSet, type ChangeOrigin, type GraphChange } from '@/features/versioning/model/changeModel'
import { WhatChangedSection } from '../WhatChangedSection'

const DRAFT: ChangeOrigin = { source: 'branch', branchId: 'br_1' }
const RANGE: ChangeOrigin = { source: 'compare', fromSeq: 41, toSeq: 42 }

function showing(changes: Omit<GraphChange, 'origin'>[], origin: ChangeOrigin = DRAFT) {
  useBranchStore.setState({ activeChangeSet: buildChangeSet(changes.map((c) => ({ ...c, origin }))) })
}

function renderSection(id: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><WhatChangedSection id={id} /></QueryClientProvider>)
}

beforeEach(() => {
  api.getChangeEntry.mockReset()
  useBranchStore.getState().reset()
  useBranchStore.setState({ workspaceId: 'ws1', graphId: 'g1' })
})

describe('WhatChangedSection', () => {
  it('says an entity was added in this draft, and what with, reading it by its entity id', async () => {
    showing([{ entityId: 'e-orders', urn: 'urn:orders', kind: 'node', status: 'added', label: 'orders' }])
    api.getChangeEntry.mockResolvedValue({ entityId: 'e-orders', kind: 'node', status: 'added', before: null,
      after: { displayName: 'orders', owner: 'sales' } })
    renderSection('urn:orders')
    expect(screen.getByText('What changed')).toBeInTheDocument()
    expect(screen.getByText('Added')).toBeInTheDocument()
    expect(screen.getByText('in this draft')).toBeInTheDocument()
    expect(await screen.findByText('sales')).toBeInTheDocument()
    expect(api.getChangeEntry).toHaveBeenCalledWith('ws1', 'g1', { branchId: 'br_1' }, 'e-orders')
  })

  it('says an entity was modified between two revisions, field by field', async () => {
    showing([{ entityId: 'urn:orders', kind: 'node', status: 'modified', label: 'orders' }], RANGE)
    api.getChangeEntry.mockResolvedValue({ entityId: 'urn:orders', kind: 'node', status: 'modified',
      before: { owner: 'finance' }, after: { owner: 'sales' } })
    renderSection('urn:orders')
    expect(screen.getByText('Modified')).toBeInTheDocument()
    expect(screen.getByText('between #41 and #42')).toBeInTheDocument()
    expect(await screen.findByText('finance')).toBeInTheDocument()
    expect(screen.getByText('sales')).toBeInTheDocument()
    expect(api.getChangeEntry).toHaveBeenCalledWith('ws1', 'g1', { fromSeq: 41, toSeq: 42 }, 'urn:orders')
  })

  it('shows a changed relationship with its ends', async () => {
    showing([{ entityId: 'edge-1', kind: 'edge', status: 'added', label: 'feeds' }])
    api.getChangeEntry.mockResolvedValue({ entityId: 'edge-1', kind: 'edge', status: 'added', before: null,
      after: { sourceEntityId: 'e-orders', targetEntityId: 'e-revenue', edgeType: 'feeds' } })
    renderSection('edge-1')
    expect(await screen.findByText('e-orders')).toBeInTheDocument()
    expect(screen.getByText('e-revenue')).toBeInTheDocument()
  })

  it('shows nothing, and asks for nothing, for an unchanged entity', () => {
    showing([{ entityId: 'urn:orders', kind: 'node', status: 'modified', label: 'orders' }])
    const { container } = renderSection('urn:customers')
    expect(container).toBeEmptyDOMElement()
    expect(api.getChangeEntry).not.toHaveBeenCalled()
  })

  it('leaves a tombstone to its own details', () => {
    showing([{ entityId: 'urn:orders', kind: 'node', status: 'removed', label: 'orders' }])
    const { container } = renderSection('urn:orders')
    expect(container).toBeEmptyDOMElement()
    expect(api.getChangeEntry).not.toHaveBeenCalled()
  })
})
