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
      ],
    },
  }),
}))
vi.mock('@/hooks/usePropertyInsights', () => ({
  useAffectedSample: () => ({ data: { entities: [{ urn: 'u1', displayName: 'orders', entityType: 'Table' }], truncated: true }, loading: false, error: null }),
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
})
