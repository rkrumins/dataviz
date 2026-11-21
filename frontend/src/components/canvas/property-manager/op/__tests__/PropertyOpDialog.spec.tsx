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
  get: vi.fn(),
  /** The What step fails to draw. */
  crash: false,
  /** How many times the counts were asked again (`useReviewCounts`' retry), as each render asked. */
  countRetries: [] as number[],
}))
let counts: ReviewCounts

vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()),
  previewPropertyJob: api.preview,
  createPropertyJob: api.create,
  getPropertyJob: api.get,
}))
vi.mock('../WhatStep', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../WhatStep')>()
  return {
    ...actual,
    WhatStep: (props: Parameters<typeof actual.WhatStep>[0]) => {
      if (api.crash) throw new Error('The What step failed to draw')
      return <actual.WhatStep {...props} />
    },
  }
})
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
vi.mock('../useReviewCounts', () => ({
  useReviewCounts: (_v: string, items: unknown, _s: string, retry = 0) => {
    api.countRetries.push(retry)
    return items ? counts : { counts: new Map(), complete: false, percent: 0, error: null, unavailable: false }
  },
}))

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
  const onOpenManager = vi.fn()
  render(
    <PropertyOpDialog viewId="v1" graphWrite={GRAPH} seed={seed} knownEntityTypes={['Table']}
      layers={[{ id: 'L1', name: 'Gold' }, { id: 'L2', name: 'Silver' }]} selectionIds={selectionIds} onClose={onClose}
      onOpenManager={onOpenManager} />,
  )
  return { onClose, onOpenManager }
}
const next = () => screen.getByRole('button', { name: /^Next/ })

beforeEach(() => {
  localStorage.clear()
  api.preview.mockReset().mockResolvedValue({ refusal: null, nameBudget: { registered: 10, nativeBudget: 50000, ceiling: 65534, isNew: false, verdict: 'ok' }, activeJobId: null, counts: null })
  api.create.mockReset().mockResolvedValue({ jobId: 'job-1', status: 'pending' })
  api.get.mockReset().mockResolvedValue({ jobId: 'job-0', status: 'running', progress: 0.3, op: { kind: 'rename', key: 'owner', to: 'steward' },
    target: { kind: 'predicate', scopeMode: 'view' }, createdAt: '2026-11-21T00:00:00Z' })
  api.crash = false
  counts = exact(120, 30)
  api.countRetries.length = 0
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

  it('applies only on a final count: not while counting, nor once a count stops — Try again counts afresh', async () => {
    const user = userEvent.setup()
    const counting = { count: 10, complete: false, percent: 40 }
    counts = { counts: new Map([['target', { ...counting, count: 40 }], ['haveKey', counting]]), complete: false, percent: 40, error: null, unavailable: false }
    open({ kind: 'remove', key: 'owner' })
    await user.click(next())
    expect(screen.getByRole('button', { name: 'Apply to 10+' })).toBeDisabled()

    counts = { ...counts, error: 'The count stopped: timed out' }
    await user.click(screen.getByRole('button', { name: /Where/ }))
    await user.click(next())
    expect(screen.getByText(/The count stopped: timed out/)).toHaveTextContent(/can’t be applied until a count finishes/)
    expect(screen.getByRole('button', { name: /^Apply/ })).toBeDisabled()
    counts = exact(120, 30)
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(api.countRetries.at(-1)).toBe(1)
    expect(screen.getByRole('button', { name: 'Apply to 30' })).toBeEnabled()
  })

  it('keeps a failed check as its own error, with Try again', async () => {
    const user = userEvent.setup()
    api.preview.mockRejectedValueOnce(new Error('The server is busy'))
    open({ kind: 'remove', key: 'owner' })
    await user.click(next())
    expect(await screen.findByText(/Couldn’t check it can be applied: The server is busy/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply to 30' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: 'Apply to 30' })).toBeEnabled()
    expect(api.preview).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(/Couldn’t check it can be applied/)).toBeNull()
  })

  it('asks for the name to be typed when the counts are only approximate, however few', async () => {
    const user = userEvent.setup()
    counts = exact(120, 30)
    counts.counts = new Map([...counts.counts].map(([id, c]) => [id, { ...c, approximate: true, note: 'Your draft changed more than 200,000 entities' }]))
    open({ kind: 'remove', key: 'owner' })
    await user.click(next())
    await user.click(screen.getByRole('button', { name: 'Apply to about 30' }))
    expect(api.create).not.toHaveBeenCalled()
    expect(screen.getByText(/Remove owner on about 30 entities/)).toBeInTheDocument()
  })

  it('asks for the name to be typed when nothing could count it, and says the number is unknown', async () => {
    const user = userEvent.setup()
    counts = { counts: new Map(), complete: false, percent: 0, error: null, unavailable: true }
    open({ kind: 'remove', key: 'owner' })
    await user.click(next())
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(api.create).not.toHaveBeenCalled()
    expect(screen.getByText('Remove owner on an unknown number of entities?')).toBeInTheDocument()
    expect(screen.getByText(/We couldn.t check what this will affect/)).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('owner'), 'owner')
    // The confirmation's own Apply — the dialog's sits behind it.
    await user.click(screen.getAllByRole('button', { name: 'Apply' }).at(-1)!)
    expect(api.create).toHaveBeenCalledTimes(1)
  })

  it('refuses a selection past 20,000 whole — never a part of it — and says what to use instead', async () => {
    const user = userEvent.setup()
    const ids = Array.from({ length: 20_001 }, (_, i) => `n${i}`)
    open({ kind: 'remove', key: 'owner', target: { kind: 'selection', ids } }, ids)
    expect(screen.getByRole('radio', { name: /The 20,001 selected/ })).toHaveAttribute('aria-checked', 'true')
    expect(next()).toBeDisabled()
    expect(screen.getAllByText('20,000 is the most a selection can change — use Whole view, Has key or a layer instead.').length).toBeGreaterThan(0)
    await user.click(screen.getByRole('radio', { name: /Every entity with owner/ }))
    expect(next()).toBeEnabled()
  })

  it('offers to follow the change already running on the draft — from Review, and when starting is refused', async () => {
    const user = userEvent.setup()
    api.preview.mockResolvedValue({ refusal: null, nameBudget: null, activeJobId: 'job-0', counts: null })
    const { onClose, onOpenManager } = open({ kind: 'remove', key: 'owner' })
    await user.click(next())
    expect(await screen.findByText(/Another change is still being applied/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Apply/ })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Follow it' }))
    expect(api.get).toHaveBeenCalledWith('ws', 'g1', 'job-0')
    expect(usePropertyJobsStore.getState().jobs).toMatchObject([{
      jobId: 'job-0', branchId: 'd1', op: { kind: 'rename', key: 'owner' }, targetLabel: 'the entities a search matches',
    }])
    expect(onClose).toHaveBeenCalled()
    expect(onOpenManager).toHaveBeenCalled()
  })

  it('a refusal to start because another is running offers to follow it', async () => {
    const user = userEvent.setup()
    const { JobActiveError } = await import('@/services/versioningApiService')
    api.create.mockRejectedValueOnce(new JobActiveError('job-0', 'Another bulk property edit is running on this draft (job job-0).'))
    const { onOpenManager } = open({ kind: 'remove', key: 'owner' })
    await user.click(next())
    await user.click(screen.getByRole('button', { name: 'Apply to 30' }))
    expect(await screen.findByText(/Another bulk property edit is running/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Follow it' }))
    expect(usePropertyJobsStore.getState().jobs.map((j) => j.jobId)).toEqual(['job-0'])
    expect(onOpenManager).toHaveBeenCalled()
  })

  it('a target the server won\'t take by its ids offers to choose another', async () => {
    const user = userEvent.setup()
    api.preview.mockResolvedValue({ refusal: { code: 'too_many_ids', message: 'A job names up to 5,000 entities by id.' }, nameBudget: null, activeJobId: null, counts: { matched: 3, haveKey: 3, haveTo: 0, missing: 0 } })
    open({ kind: 'remove', key: 'owner' }, ['a', 'b', 'c'])
    await user.click(screen.getByRole('radio', { name: /The 3 selected/ }))
    await user.click(next())
    expect(await screen.findByText('A job names up to 5,000 entities by id.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Choose another target' }))
    expect(screen.getByRole('radiogroup', { name: 'Which entities' })).toBeInTheDocument()
  })

  it('a step that fails to draw is held to the dialog, which can still be closed', async () => {
    const user = userEvent.setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    api.crash = true
    const { onClose } = open()
    const fallback = within(screen.getByText('The What step failed to draw').parentElement!)
    await user.click(fallback.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
    vi.mocked(console.error).mockRestore()
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
