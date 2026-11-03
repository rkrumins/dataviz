/**
 * SaveSearchAsViewSheet — a search's matches kept as a subset view: where they
 * are looked for, the layers they start with, a count per layer, and a save that
 * a retry can't double.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FromSearchRequest } from '@/types/searchView'
import type { Predicate } from '@/types/search'

const createFromSearch = vi.fn<(body: FromSearchRequest, key: string) => Promise<{ view: { id: string; name: string } }>>()
vi.mock('@/services/searchViewsApi', () => ({
  createFromSearch: (body: FromSearchRequest, key: string) => createFromSearch(body, key),
}))
vi.mock('../useLayerCounts', () => ({
  useLayerCounts: (_viewId: string, layers: Array<{ id: string }>) => ({
    status: 'done',
    counts: new Map(layers.map((l) => [l.id, { count: l.id === 'other-matches' ? 2 : 5, complete: true }])),
  }),
}))

import { SaveSearchAsViewSheet } from '../SaveSearchAsViewSheet'

const pii = { kind: 'tag', values: ['pii'] } as unknown as Predicate

function renderSheet(over: Partial<Parameters<typeof SaveSearchAsViewSheet>[0]> = {}) {
  const props = {
    viewId: 'v-base',
    viewName: 'Sales overview',
    workspaceId: 'ws',
    dataSourceId: 'ds',
    predicate: pii,
    boardLayers: [
      { id: 'l1', name: 'Tables', order: 0, entityTypes: ['table'] },
      { id: 'l2', name: 'Dashboards', order: 1, entityTypes: ['dashboard'] },
    ],
    boardConfig: { layout: { referenceLayout: { layers: [], assignments: {} } } },
    subset: null,
    typeCounts: [{ type: 'table', count: 3 }, { type: 'column', count: 9 }],
    onClose: vi.fn(),
    onSaved: vi.fn(),
    ...over,
  }
  render(<SaveSearchAsViewSheet {...props} />)
  return props
}

const save = () => fireEvent.click(screen.getByRole('button', { name: /Save view/ }))

describe('SaveSearchAsViewSheet', () => {
  beforeEach(() => {
    createFromSearch.mockReset()
    createFromSearch.mockResolvedValue({ view: { id: 'v-new', name: 'PII' } })
  })

  it('by default makes a subset that follows its base’s layers', async () => {
    const props = renderSheet()
    expect(screen.getByRole('radio', { name: /Like “Sales overview”/ })).toHaveAttribute('aria-checked', 'true')
    save()
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledWith({ id: 'v-new', name: 'PII' }))
    const [body] = createFromSearch.mock.calls[0]
    expect(body).toMatchObject({
      workspaceId: 'ws', dataSourceId: 'ds', predicate: pii, within: 'view', readIn: 'v-base', layout: 'inherit',
      visibility: 'private', provenance: { origin: 'search', viewId: 'v-base' },
    })
    expect(body).not.toHaveProperty('layers')
  })

  it('counts each layer it would hold, and the total', () => {
    renderSheet()
    const list = screen.getByRole('list', { name: 'What each layer holds' })
    expect(list).toHaveTextContent('Tables')
    expect(list).toHaveTextContent('Other matches')
    expect(screen.getByText('12 matches')).toBeInTheDocument()
  })

  it('over the whole data source, keeps a copy of the layers', async () => {
    renderSheet()
    fireEvent.click(screen.getByRole('radio', { name: 'The whole data source' }))
    save()
    await waitFor(() => expect(createFromSearch).toHaveBeenCalled())
    const [body] = createFromSearch.mock.calls[0]
    expect(body).toMatchObject({ within: 'dataSource', layout: 'own', rest: 'Other matches' })
    expect(body).not.toHaveProperty('readIn')
    expect(body.layers?.map((l) => l.name)).toEqual(['Tables', 'Dashboards'])
  })

  it('a layer per type found, or one layer', async () => {
    renderSheet()
    fireEvent.click(screen.getByRole('radio', { name: /A layer per type found/ }))
    save()
    await waitFor(() => expect(createFromSearch).toHaveBeenCalledTimes(1))
    expect(createFromSearch.mock.calls[0][0]).toMatchObject({ layout: 'own' })
    expect(createFromSearch.mock.calls[0][0].layers?.flatMap((l) => l.entityTypes)).toEqual(['column', 'table'])
  })

  it('one layer holds every match', async () => {
    renderSheet()
    fireEvent.click(screen.getByRole('radio', { name: /One layer/ }))
    save()
    await waitFor(() => expect(createFromSearch).toHaveBeenCalled())
    expect(createFromSearch.mock.calls[0][0]).toMatchObject({ layout: 'own', layers: [], rest: 'Matches' })
  })

  it('a retry after a failure asks with the same idempotency key', async () => {
    createFromSearch.mockRejectedValueOnce(Object.assign(new Error('503'), { status: 503 }))
    const props = renderSheet()
    save()
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    save()
    await waitFor(() => expect(props.onSaved).toHaveBeenCalled())
    const [first, second] = createFromSearch.mock.calls
    expect(first[1]).toBeTruthy()
    expect(second[1]).toBe(first[1])
  })

  it('inside a subset view, keeps both searches against the same base', async () => {
    const definition = { v: 1 as const, predicate: { kind: 'entityType', values: ['table'] } as unknown as Predicate,
      within: 'view' as const, readIn: 'v-root', layout: 'inherit' as const, provenance: { origin: 'search' as const } }
    renderSheet({ viewId: 'v-subset', subset: { definition, baseName: 'Estate' } })
    save()
    await waitFor(() => expect(createFromSearch).toHaveBeenCalled())
    expect(createFromSearch.mock.calls[0][0]).toMatchObject({
      readIn: 'v-root',
      predicate: { kind: 'group', op: 'and', children: [definition.predicate, pii] },
    })
  })
})
