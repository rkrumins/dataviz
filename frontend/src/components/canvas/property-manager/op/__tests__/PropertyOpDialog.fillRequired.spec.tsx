/**
 * PropertyOpDialog opened to fill a required field: it opens on What, "Fill if empty" on the field,
 * where its allowed values are picked with one click (only from them, when it takes no other); its
 * Where is the target it was opened with, by name — every entity of the type missing it, or the
 * entities a publish refused — and the job applies to exactly that.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReviewCounts } from '../useReviewCounts'

const api = vi.hoisted(() => ({ preview: vi.fn(), create: vi.fn() }))
vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()),
  previewPropertyJob: api.preview,
  createPropertyJob: api.create,
}))
vi.mock('@/hooks/usePropertyCatalog', () => ({
  usePropertyCatalog: () => ({ catalog: { properties: [
    { key: 'owner', count: 900, values: [{ value: 'ana', kind: 'String', count: 700 }], kinds: { String: 900 }, byEntityType: {}, distinct: 1, distinctExact: true, residual: 0 },
  ] } }),
}))
vi.mock('@/hooks/usePropertyInsights', () => ({ useAffectedSample: () => ({ data: null, loading: false, error: null }) }))
vi.mock('../../../search/builder/useDiscovery', () => ({ useDiscovery: () => ({ keysByEdgeType: {} }) }))
const counts: ReviewCounts = {
  counts: new Map([['target', { count: 40, complete: true, percent: 100 }], ['haveKey', { count: 0, complete: true, percent: 100 }]]),
  complete: true, percent: 100, error: null, unavailable: false,
}
vi.mock('../useReviewCounts', () => ({ useReviewCounts: (_v: string, items: unknown) => (items ? counts : { counts: new Map(), complete: false, percent: 0, error: null, unavailable: false }) }))

import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { usePropertyJobsStore, type OpRequest } from '@/store/propertyJobsStore'
import { useSchemaStore } from '@/store/schema'
import { PropertyOpDialog } from '../PropertyOpDialog'
import { fillRefusedRequest, fillRequiredRequest } from '../fillRequired'

const field = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, type: 'string', required: false, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 0, ...extra,
})

function open(seed: OpRequest, knownEntityTypes = ['table', 'view']) {
  render(
    <PropertyOpDialog viewId="v1" graphWrite={{ wsId: 'ws', graphId: 'g1', branchId: 'd1' }} seed={seed}
      knownEntityTypes={knownEntityTypes} layers={[]} selectionIds={[]} onClose={vi.fn()} />,
  )
}
const next = () => screen.getByRole('button', { name: /^Next/ })
const step = () => screen.getByRole('list', { name: 'Steps' }).querySelector('[aria-current="step"]')

beforeEach(() => {
  localStorage.clear()
  api.preview.mockReset().mockResolvedValue({ refusal: null, nameBudget: null, activeJobId: null, counts: null })
  api.create.mockReset().mockResolvedValue({ jobId: 'job-1', status: 'pending' })
  useStagedChangesStore.setState({ changes: [] } as never)
  usePropertyJobsStore.setState({ jobs: [], request: null } as never)
  useSchemaStore.setState({ schema: { entityTypes: [
    { id: 'view', name: 'View', pluralName: 'Views', fields: [field('tier', 'Tier', { allowedValues: ['bronze'] })] },
    { id: 'table', name: 'Table', pluralName: 'Tables', fields: [
      field('tier', 'Tier', { type: 'status', required: true, allowedValues: ['gold', 'silver'] }),
      field('dept', 'Department', { required: true, allowedValues: ['Finance', 'Sales'], allowOther: true }),
    ] },
  ] } } as never)
})

describe('PropertyOpDialog — filling a required field', () => {
  it('opens on What with the allowed values of the target type’s field, and its Where by name', async () => {
    const user = userEvent.setup()
    open(fillRequiredRequest({ entityType: 'table', entityTypeName: 'Table', field: 'tier', fieldName: 'Tier', scopeMode: 'view' }))
    // The value is still to give: What, "Fill if empty" on tier.
    expect(step()).toHaveTextContent('What')
    expect(screen.getByRole('radio', { name: /Fill if empty/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('combobox', { name: 'Property' })).toHaveValue('tier')
    // The Table's field, not the View's: only its values, no free text.
    const picker = screen.getByRole('group', { name: 'Allowed values of Tier' })
    expect(within(picker).getAllByRole('button').map((b) => b.textContent)).toEqual(['gold', 'silver'])
    expect(screen.queryByRole('textbox', { name: 'Value' })).toBeNull()
    expect(screen.getByText('Tier takes only these values — publishing refuses any other.')).toBeInTheDocument()
    expect(next()).toBeDisabled()

    await user.click(within(picker).getByRole('button', { name: 'gold' }))
    expect(within(picker).getByRole('button', { name: 'gold' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(next())
    expect(screen.getByRole('radio', { name: /Every Table missing Tier/ })).toHaveAttribute('aria-checked', 'true')
    await user.click(next())
    await user.click(screen.getByRole('button', { name: 'Apply to 40' }))

    expect(api.create).toHaveBeenCalledWith('ws', 'g1', 'd1', { kind: 'fillEmpty', key: 'tier', value: 'gold' },
      { viewId: 'v1', scopeMode: 'view', predicate: { kind: 'group', op: 'and', children: [
        { kind: 'entityType', op: 'in', values: ['table'] }, { kind: 'property', key: 'tier', op: 'isEmpty' }] } },
      expect.any(String), 'Bulk property: Fill tier on every Table missing Tier')
    expect(usePropertyJobsStore.getState().jobs).toMatchObject([{ targetLabel: 'every Table missing Tier' }])
  })

  it('offers suggested values above the free text, and a pick fills it in', async () => {
    const user = userEvent.setup()
    open(fillRequiredRequest({ entityType: 'table', field: 'dept', scopeMode: 'view' }))
    await user.click(within(screen.getByRole('group', { name: 'Suggested values of Department' })).getByRole('button', { name: 'Sales' }))
    expect(screen.getByRole('textbox', { name: 'Value' })).toHaveValue('Sales')
    expect(screen.queryByText(/takes only these values/)).toBeNull()
    expect(next()).toBeEnabled()
  })

  it('fills the entities a publish refused, by id', async () => {
    const user = userEvent.setup()
    api.preview.mockResolvedValue({ refusal: null, nameBudget: null, activeJobId: null, counts: { matched: 2, haveKey: 0, wouldChange: 2 } })
    open(fillRefusedRequest({ entityType: 'table', field: 'tier', fieldName: 'Tier', ids: ['gv:a', 'gv:b'], complete: true }), [])
    // The refused entities' type's field, whatever the view shows.
    expect(screen.getByRole('group', { name: 'Allowed values of Tier' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'silver' }))
    await user.click(next())
    expect(screen.getByRole('radio', { name: /Every table the publish refused for missing Tier/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByText('Search in')).toBeNull()
    await user.click(next())
    await user.click(await screen.findByRole('button', { name: 'Apply to 2' }))
    expect(api.create).toHaveBeenCalledWith('ws', 'g1', 'd1', { kind: 'fillEmpty', key: 'tier', value: 'silver' },
      { ids: ['gv:a', 'gv:b'] }, expect.any(String), 'Bulk property: Fill tier on every table the publish refused for missing Tier')
  })

  it('holds a list of refused entities to what one change takes', async () => {
    const user = userEvent.setup()
    const ids = Array.from({ length: 20_001 }, (_, i) => `gv:${i}`)
    open(fillRefusedRequest({ entityType: 'table', field: 'tier', fieldName: 'Tier', ids, complete: false }))
    await user.click(screen.getByRole('button', { name: 'gold' }))
    await user.click(next())
    expect(screen.getByRole('radio', { name: /The first 20,001 the publish refused/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getAllByText(/20,000 is the most a selection can change/).length).toBeGreaterThan(0)
    expect(next()).toBeDisabled()
  })
})
