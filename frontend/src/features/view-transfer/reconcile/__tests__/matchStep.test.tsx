/**
 * The Match step, as a person works through it:
 *   - remap searches the data source the view is going into (on the draft it's checked against),
 *     starting from the entity's name in the file; a result, or a pasted URN, is picked by click
 *     or keyboard; Escape leaves it undecided; with nowhere to search, a URN can still be pasted;
 *   - select-all takes every row the filters show, and a bulk choice applies to all of them;
 *   - the arrow keys move between the tabs;
 *   - entity types and relationship types are counted apart.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReconcileReport, ReconciledView } from '@/services/viewTransferApiService'

const searchNodes = vi.fn()
const getOrCreateProvider = vi.fn((..._scope: unknown[]) => ({ searchNodes }))
vi.mock('@/providers/providerPool', () => ({
  getOrCreateProvider: (...args: unknown[]) => getOrCreateProvider(...args),
}))

import { ReconciliationPanel } from '../ReconciliationPanel'
import { EntitySearchPicker } from '../EntitySearchPicker'

function report(): ReconcileReport {
  const counts = { total: 4, matched: 1, renamed: 0, typeChanged: 1, missing: 2, unknown: 0, found: 2, checked: 4, matchRate: 0.5 }
  return {
    summary: {
      entities: counts, byKind: {},
      entityTypes: { total: 3, missing: 1 }, relationshipTypes: { total: 2, missing: 0 },
      layers: { total: 1, healthy: 0 }, displayRules: 0, urnPatterns: 0, matchRate: 0.5, coverage: 1,
      verdict: 'attention', verdictReason: '2 of 4 entities aren’t here.',
    },
    entities: [
      { urn: 'urn:gone1', status: 'missing', kinds: ['assignment'], layerId: 'l1', exported: { name: 'orders_v1', type: 'dataset' }, target: null },
      { urn: 'urn:gone2', status: 'missing', kinds: ['assignment'], layerId: 'l1', exported: { name: 'orders_v2', type: 'dataset' }, target: null },
      { urn: 'urn:typed', status: 'type_changed', kinds: ['assignment'], layerId: 'l1', exported: { name: 'ledger', type: 'Table' }, target: { name: 'ledger', type: 'View' } },
    ],
    entitiesTruncated: false,
    types: { entity: [], relationship: [] },
    layers: [{ id: 'l1', name: 'Sources', ...counts, anchor: null, healthy: false }],
    notices: [],
  }
}

const RECONCILED: ReconciledView = { key: '0', effectiveDefinition: {}, effectiveHash: 'sha256:x', report: report(), update: null }
const SCOPE = { workspaceId: 'ws1', dataSourceId: 'ds1', branchId: 'br_data' }

function renderPanel(onDraft = vi.fn(), searchScope: typeof SCOPE | null = SCOPE) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ReconciliationPanel reconciled={RECONCILED} applied={{}} draft={{}} onDraft={onDraft}
        sourceLabel="dev · Finance" targetLabel="UAT · Lineage" exportedNames={{}} searchScope={searchScope} />
    </QueryClientProvider>,
  )
  return onDraft
}

beforeEach(() => {
  vi.clearAllMocks()
  searchNodes.mockResolvedValue([
    { urn: 'urn:here:orders', displayName: 'orders', entityType: 'dataset', properties: {} },
    { urn: 'urn:here:orders_hist', displayName: 'orders_history', entityType: 'dataset', properties: {} },
  ])
})

describe('Remapping an entity', () => {
  it('searches the data source it goes into, from the entity’s own name, and uses the pick', async () => {
    const onDraft = renderPanel()
    const row = screen.getByRole('group', { name: 'What to do with orders_v1' })
    fireEvent.click(within(row).getByRole('button', { name: 'remap' }))

    const input = await screen.findByRole('combobox', { name: /Search for the entity here/ })
    expect(input).toHaveValue('orders_v1')
    await waitFor(() => expect(searchNodes).toHaveBeenCalledWith('orders_v1', 8))
    expect(getOrCreateProvider).toHaveBeenCalledWith('ws1', 'ds1', 'br_data')

    fireEvent.click(await screen.findByText('orders_history'))
    expect(onDraft).toHaveBeenLastCalledWith({ drop: [], remap: { 'urn:gone1': 'urn:here:orders_hist' } })
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('picks with the keyboard, and Escape leaves it as it was', async () => {
    const onDraft = renderPanel()
    fireEvent.click(within(screen.getByRole('group', { name: 'What to do with orders_v1' })).getByRole('button', { name: 'remap' }))
    const input = await screen.findByRole('combobox')
    await screen.findByText('orders_history')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onDraft).toHaveBeenLastCalledWith({ drop: [], remap: { 'urn:gone1': 'urn:here:orders_hist' } })

    onDraft.mockClear()
    fireEvent.click(within(screen.getByRole('group', { name: 'What to do with orders_v2' })).getByRole('button', { name: 'remap' }))
    fireEvent.keyDown(await screen.findByRole('combobox'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('combobox')).not.toBeInTheDocument())
    expect(onDraft).not.toHaveBeenCalled()
  })

  it('takes a pasted URN, and with nowhere to search, that is the way', async () => {
    const onPick = vi.fn()
    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <EntitySearchPicker scope={null} exported={{ name: 'orders_v1', type: 'dataset' }} onPick={onPick} onCancel={vi.fn()} />
      </QueryClientProvider>,
    )
    const input = screen.getByRole('combobox', { name: 'URN of the entity here' })
    expect(input).toHaveValue('')
    fireEvent.change(input, { target: { value: 'urn:li:dataset:(hive,orders,PROD)' } })
    fireEvent.click(screen.getByRole('option', { name: /Use urn:li:dataset/ }))
    expect(onPick).toHaveBeenCalledWith('urn:li:dataset:(hive,orders,PROD)')
    expect(searchNodes).not.toHaveBeenCalled()
  })

  it('says when nothing here matches, without picking anything', async () => {
    searchNodes.mockResolvedValue([])
    const onPick = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EntitySearchPicker scope={SCOPE} exported={{ name: 'orders_v1' }} onPick={onPick} onCancel={vi.fn()} />
      </QueryClientProvider>,
    )
    expect(await screen.findByText('Nothing here matches “orders_v1”.')).toBeInTheDocument()
    await act(async () => { fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' }) })
    expect(onPick).not.toHaveBeenCalled()
  })
})

describe('The entities to review', () => {
  it('selects every row shown, and a bulk choice takes them all', () => {
    const onDraft = renderPanel()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all 2' }))
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Drop' }))
    expect(onDraft.mock.lastCall![0].drop.sort()).toEqual(['urn:gone1', 'urn:gone2'])
  })

  it('moves between the tabs with the arrow keys', () => {
    renderPanel()
    const notFound = screen.getByRole('tab', { name: /Not found/ })
    fireEvent.keyDown(notFound, { key: 'ArrowRight' })
    const typeChanged = screen.getByRole('tab', { name: /Type changed/ })
    expect(typeChanged).toHaveAttribute('aria-selected', 'true')
    expect(typeChanged).toHaveFocus()
    expect(screen.getByText('ledger')).toBeInTheDocument()
  })

  it('counts entity and relationship types apart', () => {
    renderPanel()
    expect(screen.getByText('Entity types').closest('div')).toHaveTextContent('2 / 3')
    expect(screen.getByText('Relationship types').closest('div')).toHaveTextContent('2 / 2')
  })
})
