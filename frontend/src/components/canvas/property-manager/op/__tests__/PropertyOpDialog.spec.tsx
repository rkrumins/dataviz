/**
 * PropertyOpDialog — a bulk property change, guided: What (operation, property, value), Where
 * (which entities — ready-made targets, the view or, on purpose, the whole data source), Review
 * (counted exactly, with anything that stops it), then started on the draft as a job that is
 * tracked. A large removal asks for the name to be typed; staged edits are saved first; a retry
 * after a failure carries the same key.
 */
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReviewCounts } from '../useReviewCounts'

const api = vi.hoisted(() => ({
  preview: vi.fn(),
  create: vi.fn(),
}))
let counts: ReviewCounts

vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()),
  previewPropertyJob: api.preview,
  createPropertyJob: api.create,
}))
vi.mock('@/hooks/usePropertyCatalog', () => ({
  usePropertyCatalog: () => ({
    catalog: {
      properties: [
        { key: 'owner', count: 900, values: [{ value: 'ana', kind: 'String', count: 700 }], kinds: { String: 900 }, byEntityType: {}, distinct: 1, distinctExact: true, residual: 0 },
        { key: 'steward', count: 40, values: [], kinds: { String: 40 }, byEntityType: {}, distinct: 1, distinctExact: true, residual: 0 },
        { key: 'dept', count: 300, kinds: { String: 300 }, byEntityType: {}, distinct: 3, distinctExact: true, residual: 0, values: [
          { value: 'Finance', kind: 'String', count: 200 }, { value: 'finance ', kind: 'String', count: 80 },
          { value: 'FINANCE', kind: 'String', count: 20 }] },
        { key: 'rank', count: 17, kinds: { Integer: 10, String: 7 }, byEntityType: {}, distinct: 3, distinctExact: true, residual: 0, values: [
          { value: 7, kind: 'Integer', count: 10 }, { value: '42', kind: 'String', count: 5 }, { value: 'n/a', kind: 'String', count: 2 }] },
      ],
    },
  }),
}))
let allValues: unknown[] | null = null
vi.mock('../useAllValues', () => ({ useAllValues: () => ({ values: allValues, loading: false, error: null }) }))
vi.mock('@/hooks/usePropertyInsights', () => ({
  useAffectedSample: () => ({ data: { entities: [{ urn: 'u1', displayName: 'orders', entityType: 'Table' }], truncated: true }, loading: false, error: null }),
}))
vi.mock('../../../search/builder/useDiscovery', () => ({
  useDiscovery: () => ({ keysByEdgeType: { FLOWS_TO: ['owner', 'confidence'], FEEDS: ['owner', 'sla'] } }),
}))
vi.mock('../useReviewCounts', () => ({ useReviewCounts: (_v: string, items: unknown) => (items ? counts : { counts: new Map(), complete: false, percent: 0, error: null, unavailable: false }) }))

import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { usePropertyJobsStore } from '@/store/propertyJobsStore'
import { PropertyOpDialog } from '../PropertyOpDialog'

const GRAPH = { wsId: 'ws', graphId: 'g1', branchId: 'd1' }
const exact = (target: number, haveKey: number, haveTo = 0): ReviewCounts => ({
  counts: new Map([
    ['target', { count: target, complete: true, percent: 100 }],
    ['haveKey', { count: haveKey, complete: true, percent: 100 }],
    ['haveTo', { count: haveTo, complete: true, percent: 100 }],
  ]),
  complete: true, percent: 100, error: null, unavailable: false,
})

function open(seed = {}, selectionIds: string[] = []) {
  const onClose = vi.fn()
  render(
    <PropertyOpDialog viewId="v1" graphWrite={GRAPH} seed={seed} knownEntityTypes={['Table']}
      layers={[{ id: 'L1', name: 'Gold' }, { id: 'L2', name: 'Silver' }]} selectionIds={selectionIds} onClose={onClose} />,
  )
  return { onClose }
}
const next = () => screen.getByRole('button', { name: /^Next/ })

beforeEach(() => {
  localStorage.clear()
  api.preview.mockReset().mockResolvedValue({ refusal: null, nameBudget: { registered: 10, nativeBudget: 50000, ceiling: 65534, isNew: false, verdict: 'ok' }, activeJobId: null, counts: null })
  api.create.mockReset().mockResolvedValue({ jobId: 'job-1', status: 'pending' })
  counts = exact(120, 30)
  allValues = null
  useStagedChangesStore.setState({ changes: [] } as never)
  usePropertyJobsStore.setState({ jobs: [], request: null } as never)
})

describe('PropertyOpDialog', () => {
  it('guides a new property onto a layer: What, Where, Review — then starts it on the draft and tracks it', async () => {
    const user = userEvent.setup()
    const { onClose } = open()
    expect(next()).toBeDisabled()
    await user.type(screen.getByRole('combobox', { name: 'Property' }), 'tier')
    await user.type(screen.getByRole('textbox', { name: 'Value' }), 'gold')
    await user.click(next())

    // Where: the ready-made targets.
    const where = within(screen.getByRole('radiogroup', { name: 'Which entities' }))
    expect(where.getByRole('radio', { name: /Every entity in the view/ })).toBeInTheDocument()
    await user.click(where.getByRole('radio', { name: /A layer/ }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Layer' }), 'L2')
    // A layer is searched in the view.
    expect(screen.getByRole('radio', { name: 'The whole data source' })).toBeDisabled()
    await user.click(next())

    // Review: counted.
    expect(screen.getByText('Will change').nextSibling).toHaveTextContent('120')
    expect(screen.getByText('orders')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Apply to 120' }))

    expect(api.create).toHaveBeenCalledWith('ws', 'g1', 'd1',
      { kind: 'set', key: 'tier', value: 'gold' },
      { viewId: 'v1', predicate: { kind: 'layer', layerAssignment: 'L2' }, scopeMode: 'view' },
      expect.any(String), expect.stringContaining('Set tier on the Silver layer'))
    expect(usePropertyJobsStore.getState().jobs).toMatchObject([{ jobId: 'job-1', targetLabel: 'the Silver layer', op: { kind: 'set', key: 'tier' } }])
    expect(onClose).toHaveBeenCalled()
  })

  it('opens a removal from a property on Where; the whole data source has to be meant', async () => {
    const user = userEvent.setup()
    open({ kind: 'remove', key: 'owner' })
    expect(screen.getByRole('radio', { name: /Every entity with owner/ })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('radio', { name: 'The whole data source' }))
    expect(next()).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: 'I mean the whole data source' }))
    expect(next()).toBeEnabled()
  })

  it('asks for the property name to be typed before removing it from a thousand or more', async () => {
    const user = userEvent.setup()
    counts = exact(5000, 1800)
    open({ kind: 'remove', key: 'owner' })
    await user.click(next())
    await user.click(screen.getByRole('button', { name: 'Apply to 1,800' }))
    expect(api.create).not.toHaveBeenCalled()
    expect(screen.getByText(/Remove owner on 1,800 entities/)).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('owner'), 'owner')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(api.create).toHaveBeenCalledTimes(1)
  })

  it('a rename says how many already hold the new name, and leaves them alone unless told', async () => {
    const user = userEvent.setup()
    counts = exact(900, 900, 40)
    open({ kind: 'rename', key: 'owner' })
    await user.click(screen.getByRole('button', { name: /What/ }))
    await user.type(screen.getByRole('textbox', { name: 'New name' }), 'steward')
    expect(screen.getByText(/40 entities already hold/)).toBeInTheDocument()
    await user.click(next())
    await user.click(next())
    expect(screen.getByText('Will change').nextSibling).toHaveTextContent('860')
  })

  it('targets a container\'s children, or everything inside it, when opened from one', async () => {
    const user = userEvent.setup()
    open({ kind: 'set', key: 'owner', target: { kind: 'children', urns: ['urn:db'], label: 'Sales DB' } })
    await user.type(screen.getByRole('textbox', { name: 'Value' }), 'ana')
    await user.click(next())
    expect(screen.getByRole('radio', { name: /The children of Sales DB/ })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('radio', { name: /Everything inside Sales DB/ }))
    await user.click(next())
    await user.click(screen.getByRole('button', { name: /^Apply/ }))
    expect(api.create.mock.calls[0][4]).toEqual({
      viewId: 'v1', scopeMode: 'view',
      predicate: { kind: 'related', axis: 'ancestor', where: { kind: 'is', refs: [{ urn: 'urn:db' }] } },
    })
  })

  it('sends a canvas selection as its entities, counted on the draft', async () => {
    const user = userEvent.setup()
    api.preview.mockResolvedValue({ refusal: null, nameBudget: null, activeJobId: null, counts: { matched: 3, haveKey: 1, haveTo: 0, missing: 0 } })
    open({ kind: 'fillEmpty', key: 'owner' }, ['a', 'b', 'c'])
    await user.type(screen.getByRole('textbox', { name: 'Value' }), 'ana')
    await user.click(next())
    await user.click(screen.getByRole('radio', { name: /The 3 selected/ }))
    await user.click(next())
    expect(await screen.findByRole('button', { name: 'Apply to 2' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Apply to 2' }))
    expect(api.create.mock.calls[0][4]).toEqual({ ids: ['a', 'b', 'c'] })
  })

  it('waits for staged edits to be saved, and says what stops it', async () => {
    const user = userEvent.setup()
    useStagedChangesStore.setState({ changes: [{ id: 'x' }] } as never)
    open({ kind: 'remove', key: 'owner' })
    await user.click(next())
    expect(screen.getByText(/1 staged change not saved yet/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Apply/ })).toBeDisabled()

    act(() => useStagedChangesStore.setState({ changes: [] } as never))
    api.preview.mockResolvedValue({ refusal: { code: 'reserved_key', message: '“urn” is kept by the platform.' }, nameBudget: null, activeJobId: null, counts: null })
    await user.click(screen.getByRole('button', { name: /Where/ }))
    await user.click(screen.getByRole('radio', { name: /Every entity in the view/ }))
    await user.click(next())
    expect(await screen.findByText('“urn” is kept by the platform.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Apply/ })).toBeDisabled()
  })

  it('retries after a failure with the same key', async () => {
    const user = userEvent.setup()
    api.create.mockRejectedValueOnce(new Error('The server is busy'))
    open({ kind: 'remove', key: 'owner' })
    await user.click(next())
    await user.click(screen.getByRole('button', { name: /^Apply/ }))
    expect(await screen.findByText('The server is busy')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(api.create).toHaveBeenCalledTimes(2)
    expect(api.create.mock.calls[0][5]).toBe(api.create.mock.calls[1][5])
  })

  it('says what publishing the draft would refuse of it — and applies it all the same', async () => {
    const user = userEvent.setup()
    api.preview.mockResolvedValue({
      refusal: null, nameBudget: { registered: 10, nativeBudget: 50000, ceiling: 65534, isNew: false, verdict: 'ok' },
      activeJobId: null, counts: null,
      warnings: [{ code: 'field_required', entityType: 'Table', field: 'owner',
        message: "Owner is required on Table: a Table it is removed from can't be published until it has one again." }],
    })
    open({ kind: 'remove', key: 'owner' })
    await user.click(next())
    expect(await screen.findByText(/Owner is required on Table: a Table it is removed from/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Apply to 30' }))
    expect(api.create).toHaveBeenCalledTimes(1)
  })
})

describe('PropertyOpDialog — cleaning up a property’s values', () => {
  it('normalizes from Clean up…: opens on What with before → after, counts at most, and keeps the reason', async () => {
    const user = userEvent.setup()
    open({ kind: 'normalize', key: 'dept' })
    expect(screen.getByRole('heading', { name: 'Clean up a property' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Normalize/ })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('radio', { name: 'lower' }))
    const preview = within(screen.getByRole('list', { name: 'Before and after' }))
    expect(preview.getAllByText('“finance”')).toHaveLength(3)
    expect(preview.getByText('“finance ”')).toBeInTheDocument()
    expect(screen.getByText(/Two or more values become one/)).toBeInTheDocument()

    await user.click(next())
    await user.click(next())
    expect(screen.getByText('Will change').nextSibling).toHaveTextContent(/up to\s*30/)
    expect(screen.getByText(/At most: what it changes is known/)).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: /Reason/ }), 'One spelling per department')
    await user.click(screen.getByRole('button', { name: 'Apply to up to 30' }))
    expect(api.create).toHaveBeenCalledWith('ws', 'g1', 'd1',
      { kind: 'normalize', key: 'dept', trim: true, collapseSpaces: false, case: 'lower', dedupeList: false },
      { viewId: 'v1', predicate: { kind: 'hasProperty', key: 'dept', negate: false }, scopeMode: 'view' },
      expect.any(String), 'One spelling per department')
    expect(usePropertyJobsStore.getState().jobs[0]!.op.kind).toBe('normalize')
  })

  it('finds a property’s near-duplicates among every value it holds, and merges each group into the one picked', async () => {
    const user = userEvent.setup()
    allValues = [
      { value: 'Finance', kind: 'String', count: 200 }, { value: 'finance ', kind: 'String', count: 80 },
      { value: 'FINANCE', kind: 'String', count: 20 }, { value: 'Ops', kind: 'String', count: 50 }, { value: 'ops ', kind: 'String', count: 5 },
    ]
    open({ kind: 'mapValues', key: 'dept' })
    const groups = within(screen.getByRole('list', { name: 'Values to merge' }))
    expect(groups.getByText(/3 values →/)).toHaveTextContent('3 values → “Finance”')
    await user.click(groups.getAllByRole('checkbox')[1]!)                       // not the Ops ones
    await user.click(groups.getByRole('radio', { name: 'Keep “FINANCE”' }))
    expect(screen.getByText(/Merges/)).toHaveTextContent('Merges 2 values into another — held by about 280 entities in this view.')
    await user.click(next())
    await user.click(next())
    await user.click(screen.getByRole('button', { name: /^Apply/ }))
    expect(api.create.mock.calls[0][3]).toEqual({ kind: 'mapValues', key: 'dept', dedupeList: true, map: [
      { from: 'Finance', fromKind: 'String', to: 'FINANCE', toKind: 'String' },
      { from: 'finance ', fromKind: 'String', to: 'FINANCE', toKind: 'String' }] })
  })

  it('merges the values picked on the catalog into the one they chose', async () => {
    const user = userEvent.setup()
    const map = [{ from: 'FINANCE', fromKind: 'String' as const, to: 'Finance', toKind: 'String' as const }]
    open({ kind: 'mapValues', key: 'dept', map })
    expect(within(screen.getByRole('list', { name: 'Values to merge' })).getAllByRole('checkbox')).toHaveLength(1)
    await user.click(next())
    await user.click(next())
    await user.click(screen.getByRole('button', { name: /^Apply/ }))
    expect(api.create.mock.calls[0][3]).toEqual({ kind: 'mapValues', key: 'dept', dedupeList: true, map })
  })

  it('converts to one kind, saying how it is stored now and which values won’t convert', async () => {
    const user = userEvent.setup()
    open({ kind: 'convert', key: 'rank', toKind: 'Integer' })
    expect(screen.getByText(/^Stored as/)).toHaveTextContent('Stored as Integer on 10 and Text on 7 entities in this view.')
    expect(within(screen.getByRole('list', { name: 'Before and after' })).getByText('“42”')).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Values that won’t convert' })).getByText('“n/a”')).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'Remove rank from them' }))
    await user.click(next())
    await user.click(next())
    // At most those holding it as another kind, in this view.
    expect(screen.getByText(/A value that won’t convert is removed/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Apply to up to 7' }))
    expect(api.create.mock.calls[0][3]).toEqual({ kind: 'convert', key: 'rank', toKind: 'Integer', onFail: 'remove' })
  })

  it('counts a clean-up of named entities exactly, from the draft', async () => {
    const user = userEvent.setup()
    api.preview.mockResolvedValue({ refusal: null, nameBudget: null, activeJobId: null,
      counts: { matched: 3, haveKey: 3, haveTo: null, missing: 0, wouldChange: 2, unconvertible: 1 } })
    open({ kind: 'convert', key: 'rank', toKind: 'Integer' }, ['a', 'b', 'c'])
    await user.click(next())
    await user.click(screen.getByRole('radio', { name: /The 3 selected/ }))
    await user.click(next())
    expect(await screen.findByRole('button', { name: 'Apply to 2' })).toBeEnabled()
    expect(screen.getByText(/1 of them hold a value that won’t convert/)).toBeInTheDocument()
  })

  it('changes picked relationships: named from their keys, counted on the draft, the roll-ups among them left alone', async () => {
    const user = userEvent.setup()
    api.preview.mockResolvedValue({ refusal: null, nameBudget: null, activeJobId: null, counts: { matched: 2, haveKey: 1, haveTo: 0, missing: 0, derived: 1 } })
    open({ target: { kind: 'relationships', ids: ['e1', 'e2', 'r1'] } })
    expect(screen.getByText(/On every relationship it should reach/)).toBeInTheDocument()
    // An edge's own field can't be named.
    await user.type(screen.getByRole('combobox', { name: 'Property' }), 'confidence')
    expect(screen.getByRole('alert')).toHaveTextContent(/kept by the platform/)
    await user.clear(screen.getByRole('combobox', { name: 'Property' }))
    await user.click(screen.getByRole('combobox', { name: 'Property' }))
    await user.click(screen.getByRole('option', { name: /sla/ }))
    await user.type(screen.getByRole('textbox', { name: 'Value' }), '4h')
    await user.click(next())
    // Only the relationships it was opened on; no scope to choose.
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual([expect.stringMatching(/The 3 relationships/)])
    expect(screen.queryByText('Search in')).toBeNull()
    await user.click(next())
    expect(api.preview.mock.calls.at(-1)![4]).toEqual({ edgeIds: ['e1', 'e2', 'r1'] })
    expect(await screen.findByText(/1 of them is a roll-up/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Apply to 2' }))
    expect(api.create.mock.calls[0][4]).toEqual({ edgeIds: ['e1', 'e2', 'r1'] })
    expect(usePropertyJobsStore.getState().jobs[0]).toMatchObject({ entityKind: 'edge', targetLabel: 'the 3 selected relationships' })
  })

  it('a Connections search\'s relationships are its predicate, in the view or the whole data source', async () => {
    const user = userEvent.setup()
    const edges = { kind: 'edges', edgeTypes: ['FLOWS_TO'] }
    open({ kind: 'remove', key: 'owner', target: { kind: 'connections', predicate: edges, scopeMode: 'view', label: 'the search’s relationships', count: 40 } })
    expect(screen.getByRole('radio', { name: /The search’s relationships/ })).toHaveTextContent('— 40')
    await user.click(next())
    await user.click(screen.getByRole('button', { name: /^Apply/ }))
    expect(api.create.mock.calls[0][4]).toEqual({ viewId: 'v1', predicate: edges, scopeMode: 'view' })
  })
})
