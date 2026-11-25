/**
 * PropertyOpDialog over the view's relationships, opened from Property Manager: their properties
 * are named from the view's relationship catalog — counted, every value read from it, their kinds
 * bounding a convert — and the change reaches every relationship in the view, or those holding the
 * property. Where no relationship catalog can be read (a provider answering 501), the keys
 * discovery samples and the values read from those a change reaches stand in.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PropertyCatalogState } from '@/hooks/usePropertyCatalog'
import type { SearchCatalogProperty } from '@/types/search'

import type { ReviewCounts } from '../useReviewCounts'

const api = vi.hoisted(() => ({
  preview: vi.fn(), sample: vi.fn(), values: vi.fn(), create: vi.fn(),
  discovery: [] as Array<string | null>,
  allValues: [] as Array<{ key: string; enabled: boolean; subject: string }>,
}))
vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()),
  previewPropertyJob: api.preview,
  previewPropertyJobSample: api.sample,
  previewPropertyJobValues: api.values,
  createPropertyJob: api.create,
}))

const property = (over: Partial<SearchCatalogProperty> & { key: string }): SearchCatalogProperty => ({
  count: 0, distinct: 0, distinctExact: true, byEntityType: {}, kinds: {}, values: [], residual: 0, ...over,
})
/** The view's relationships, as their catalog reads them. */
const RELATIONSHIPS = [
  property({ key: 'sla', count: 3100, kinds: { String: 3100 }, distinct: 2, byEntityType: { PRODUCES: 3100 },
    values: [{ value: '4h', kind: 'String', count: 3000 }, { value: '1d', kind: 'String', count: 100 }] }),
  property({ key: 'retries', count: 43, kinds: { Integer: 40, String: 3 }, distinct: 3, byEntityType: { TRANSFORMS: 43 },
    values: [{ value: 1, kind: 'Integer', count: 40 }, { value: '2', kind: 'String', count: 2 }, { value: 'n/a', kind: 'String', count: 1 }] }),
]
let relationships: Partial<PropertyCatalogState>
vi.mock('@/hooks/usePropertyCatalog', () => ({
  usePropertyCatalog: (_viewId: string, subject = 'entities') => (subject === 'relationships' ? relationships : {
    catalog: { status: 'complete', properties: [property({ key: 'owner', count: 900, kinds: { String: 900 } })] },
  }),
}))
vi.mock('../useAllValues', () => ({
  useAllValues: (_view: string, key: string, enabled = true, subject = 'entities') => {
    api.allValues.push({ key, enabled, subject })
    return { values: enabled ? RELATIONSHIPS.find((p) => p.key === key)?.values ?? [] : null, loading: false, error: null, retry: vi.fn() }
  },
}))
vi.mock('../../../search/builder/useDiscovery', () => ({
  useDiscovery: (viewId: string | null) => {
    api.discovery.push(viewId)
    return { keysByEdgeType: { FLOWS_TO: ['sla', 'confidence'], FEEDS: ['sla', 'ticket'] } }
  },
}))
let counts: ReviewCounts
vi.mock('../useReviewCounts', () => ({
  useReviewCounts: (_v: string, items: unknown) => (items ? counts : { counts: new Map(), complete: false, percent: 0, error: null, unavailable: false }),
}))

import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { usePropertyJobsStore, type OpRequest } from '@/store/propertyJobsStore'
import { PropertyOpDialog } from '../PropertyOpDialog'

const exact = (target: number, haveKey: number): ReviewCounts => ({
  counts: new Map([
    ['target', { count: target, complete: true, percent: 100 }],
    ['haveKey', { count: haveKey, complete: true, percent: 100 }],
    ['haveTo', { count: 0, complete: true, percent: 100 }],
  ]),
  complete: true, percent: 100, error: null, unavailable: false,
})

function open(seed: OpRequest) {
  render(
    <PropertyOpDialog viewId="v1" graphWrite={{ wsId: 'ws', graphId: 'g1', branchId: 'd1' }} seed={seed} knownEntityTypes={[]}
      layers={[]} selectionIds={[]} onClose={vi.fn()} />,
  )
}
const next = () => screen.getByRole('button', { name: /^Next/ })
const WITH_SLA = { kind: 'edges', edgeClass: 'any', edgePredicate: { kind: 'edgeHasProperty', key: 'sla', negate: false } }

beforeEach(() => {
  localStorage.clear()
  api.preview.mockReset().mockResolvedValue({ refusal: null, nameBudget: null, activeJobId: null, counts: null })
  api.sample.mockReset().mockResolvedValue({ rows: [], truncated: false })
  api.values.mockReset().mockResolvedValue({ property: null, read: 0, truncated: false })
  api.create.mockReset().mockResolvedValue({ jobId: 'job-1', status: 'pending' })
  api.discovery.length = 0
  api.allValues.length = 0
  relationships = {
    catalog: { sessionId: 's', subject: 'relationships', status: 'complete', stale: false, entities: 31_200,
      entityTypes: [{ type: 'PRODUCES', count: 3100 }], properties: RELATIONSHIPS, tags: [] },
    reading: null, error: null, unavailable: false,
  }
  counts = exact(3100, 3100)
  useStagedChangesStore.setState({ changes: [] } as never)
  usePropertyJobsStore.setState({ jobs: [], request: null } as never)
})

describe('PropertyOpDialog — the view’s relationships, from Property Manager', () => {
  it('names a property from the relationship catalog, counted, and reaches the relationships holding it', async () => {
    const user = userEvent.setup()
    counts = exact(3100, 120)
    open({ kind: 'set', key: 'sla', target: { kind: 'relationshipsWithKey', key: 'sla' } })
    expect(screen.getByText(/On every relationship it should reach/)).toBeInTheDocument()
    expect(screen.getByText(/^Held by/)).toHaveTextContent('Held by 3,100 relationships in this view.')
    // Its values are a click away, as the catalog counts them.
    expect(screen.getByRole('button', { name: /^4h/ })).toHaveTextContent('4h3,000')
    await user.type(screen.getByRole('textbox', { name: 'Value' }), '8h')
    await user.click(next())

    // Where: every relationship in the view, or those holding it — searched in the view or the data source.
    const where = within(screen.getByRole('radiogroup', { name: 'Which relationships' }))
    expect(where.getAllByRole('radio').map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^Every relationship in the view/), expect.stringMatching(/^Every relationship with sla/)])
    expect(where.getByRole('radio', { name: /Every relationship with sla/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'The whole data source' })).toBeEnabled()
    await user.click(next())

    await user.click(await screen.findByRole('button', { name: 'Apply to 3,100' }))
    expect(api.create.mock.calls[0][4]).toEqual({ viewId: 'v1', predicate: WITH_SLA, scopeMode: 'view' })
    expect(usePropertyJobsStore.getState().jobs[0]).toMatchObject({ entityKind: 'edge', targetLabel: 'every relationship with sla' })
    // Nothing sampled in the catalog's place.
    expect(api.discovery.every((v) => v === null)).toBe(true)
    expect(api.values).not.toHaveBeenCalled()
  })

  it('adds a property to every relationship in the view from New — or across the whole data source', async () => {
    const user = userEvent.setup()
    counts = exact(31_200, 0)
    open({ target: { kind: 'viewRelationships' } })
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Add a property')
    // The relationship catalog's keys are offered, each with how many relationships hold it.
    await user.click(screen.getByRole('combobox', { name: 'Property' }))
    expect(screen.getByRole('option', { name: /retries/ })).toHaveTextContent('retries43')
    await user.type(screen.getByRole('combobox', { name: 'Property' }), 'reviewedBy')
    expect(screen.getByText(/A new property/)).toHaveTextContent('none of the view’s relationships carries it yet')
    await user.type(screen.getByRole('textbox', { name: 'Value' }), 'ana')
    await user.click(next())
    expect(screen.getByRole('radio', { name: /Every relationship in the view/ })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('radio', { name: 'The whole data source' }))
    expect(screen.getByText(/outside this view are changed too/)).toHaveTextContent('Relationships outside this view are changed too')
    await user.click(screen.getByRole('checkbox', { name: 'I mean the whole data source' }))
    await user.click(next())
    await user.click(await screen.findByRole('button', { name: /^Apply/ }))
    expect(api.create.mock.calls[0][4]).toEqual({ viewId: 'v1', predicate: { kind: 'edges', edgeClass: 'any' }, scopeMode: 'data_source' })
  })

  it('cleans up a relationship property from every value its catalog keeps, its kinds bounding a convert', async () => {
    const user = userEvent.setup()
    counts = exact(43, 43)
    open({ kind: 'convert', key: 'retries', toKind: 'Integer', target: { kind: 'relationshipsWithKey', key: 'retries' } })
    expect(screen.getByText(/^Stored as/)).toHaveTextContent('Stored as Integer on 40 and Text on 3 relationships in this view.')
    // Every value, from the relationships' catalog — none read from the relationships one by one.
    expect(api.allValues).toContainEqual({ key: 'retries', enabled: true, subject: 'relationships' })
    expect(screen.getByRole('group', { name: /won’t convert/ })).toHaveTextContent('n/a')
    expect(api.values).not.toHaveBeenCalled()
    await user.click(next())
    await user.click(next())
    // At most those holding it as another kind than Integer.
    expect(await screen.findByRole('button', { name: 'Apply to at most 3' })).toBeInTheDocument()
  })

  it('falls back to the keys discovery samples and the values read from the relationships, where no catalog can be read', async () => {
    const user = userEvent.setup()
    relationships = { catalog: null, reading: null, error: null, unavailable: true }
    api.values.mockResolvedValue({ read: 2, truncated: false, property: property({
      key: 'sla', count: 2, kinds: { String: 2 }, distinct: 2, values: [{ value: ' 4h', kind: 'String', count: 1 }, { value: '1d', kind: 'String', count: 1 }] }) })
    open({ kind: 'normalize', key: 'sla', target: { kind: 'relationshipsWithKey', key: 'sla' } })
    expect(api.discovery).toContain('v1')
    expect(screen.getByText(/carry it/)).toHaveTextContent('The view’s relationships carry it.')
    expect(await screen.findByText('“ 4h”')).toBeInTheDocument()
    expect(api.values).toHaveBeenCalledWith('ws', 'g1', 'd1', 'sla', { viewId: 'v1', predicate: WITH_SLA, scopeMode: 'view' }, expect.any(AbortSignal))
    // Uncounted keys: none says how many hold it.
    await user.clear(screen.getByRole('combobox', { name: 'Property' }))
    await user.click(screen.getByRole('combobox', { name: 'Property' }))
    expect(screen.getByRole('option', { name: /ticket/ })).toHaveTextContent(/^ticket$/)
  })
})
