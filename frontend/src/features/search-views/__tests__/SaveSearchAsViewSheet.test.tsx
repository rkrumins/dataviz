/**
 * SaveSearchAsViewSheet — a search's matches kept as a subset view: where they
 * are looked for, the layers they start with, a count per layer, and a save that
 * a retry can't double.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FromSearchRequest } from '@/types/searchView'
import type { Predicate } from '@/types/search'

const createFromSearch = vi.fn<(body: FromSearchRequest, key: string) => Promise<{ view: { id: string; name: string } }>>()
vi.mock('@/services/searchViewsApi', () => ({
  createFromSearch: (body: FromSearchRequest, key: string) => createFromSearch(body, key),
}))
const counted = vi.fn()
// What the counts answer for each rule: 5 a layer, 12 in all, 2 in a by-type Other matches.
type Answer = { count: number; complete: boolean; error?: string }
let answerFor: (id: string) => Answer = (id) =>
  ({ count: id === '__found__' ? 12 : id === 'other-matches' ? 2 : 5, complete: true })
vi.mock('../useLayerCounts', () => ({
  useLayerCounts: (_viewId: string, layers: Array<{ id: string; predicate: unknown }>) => {
    counted(layers)
    return { status: 'done', counts: new Map(layers.map((l) => [l.id, answerFor(l.id)])) }
  },
}))

// The kinds the view would hold: what the server's by-type breakdown answers, per question.
type Breakdown = { status: 'loading' } | { status: 'done'; types: Array<{ type: string; count: number }> } | { status: 'error' }
let breakdownOf: (predicate: unknown) => Breakdown = () => ({ status: 'done', types: [{ type: 'table', count: 3 }, { type: 'column', count: 9 }] })
const askedTypes = vi.fn()
vi.mock('../useTypeBreakdown', () => ({
  useTypeBreakdown: (viewId: string | null, predicate: unknown, wholeDataSource: boolean) => {
    if (!viewId) return { status: 'idle' }
    askedTypes(viewId, predicate, wholeDataSource)
    return breakdownOf(predicate)
  },
}))

// The view's kinds, by the names its schema gives them.
vi.mock('@/hooks/useViewSchema', () => ({
  useViewEntityTypes: () => [
    { id: 'table', name: 'Table', visual: { color: '#0ea5e9' } },
    { id: 'column', name: 'Column', visual: { color: '#a855f7' } },
  ],
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
    onClose: vi.fn(),
    onSaved: vi.fn(),
    ...over,
  }
  render(<SaveSearchAsViewSheet {...props} />)
  return props
}

const save = () => fireEvent.click(screen.getByRole('button', { name: /Save view/ }))
/** What the view finds, as the preview last counted it. */
const found = () => (counted.mock.calls.at(-1)![0] as Array<{ id: string; predicate: unknown }>)
  .find((l) => l.id === '__found__')!.predicate

describe('SaveSearchAsViewSheet', () => {
  beforeEach(() => {
    createFromSearch.mockReset()
    createFromSearch.mockResolvedValue({ view: { id: 'v-new', name: 'PII' } })
    askedTypes.mockReset()
    breakdownOf = () => ({ status: 'done', types: [{ type: 'table', count: 3 }, { type: 'column', count: 9 }] })
    answerFor = (id) => ({ count: id === '__found__' ? 12 : id === 'other-matches' ? 2 : 5, complete: true })
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

  it('following its base, counts what the base places in each layer, Other matches what is left', () => {
    renderSheet()
    const asked = counted.mock.calls.at(-1)?.[0] as Array<{ id: string; predicate: unknown }>
    expect(asked.map((l) => l.id)).toEqual(['l1', 'l2', '__found__'])
    expect(asked[0].predicate).toEqual(
      { kind: 'group', op: 'and', children: [pii, { kind: 'layer', layerAssignment: 'l1' }] })
    expect(asked[2].predicate).toEqual(pii)
    const rest = screen.getByText('Other matches').closest('li') as HTMLElement
    expect(rest).toHaveTextContent('2')
    expect(rest).toHaveTextContent('the rest')
  })

  it('a layer its base fills by hand, listing no types, is kept and counted', async () => {
    const props = renderSheet({ boardLayers: [
      { id: 'src', name: 'Source systems', order: 0 }, { id: 'rep', name: 'Reporting', order: 1 }] })
    const src = screen.getByText('Source systems').closest('li') as HTMLElement
    expect(src).toHaveTextContent('5')
    expect(src).not.toHaveTextContent('nothing to hold')
    save()
    await waitFor(() => expect(props.onSaved).toHaveBeenCalled())
  })

  it('a base a live view can’t follow is counted by type, says why, and offers a list', () => {
    answerFor = (id) => (id === 'l1' || id === 'l2'
      ? { count: 0, complete: true, error: 'This view places 1,200 entities by hand, and a layer filter can follow at most 1,000.' }
      : { count: id === 'other-matches' ? 2 : 5, complete: true })
    const onKeepAsList = vi.fn()
    renderSheet({ onKeepAsList })
    expect(screen.getByText(/A live view can’t follow how “Sales overview” places entities/)).toBeInTheDocument()
    const asked = counted.mock.calls.at(-1)?.[0] as Array<{ id: string; predicate: unknown }>
    expect(asked.map((l) => l.id)).toEqual(['l1', 'l2', 'other-matches'])
    expect(asked[0].predicate).toEqual(
      { kind: 'group', op: 'and', children: [pii, { kind: 'entityType', op: 'in', values: ['table'] }] })
    fireEvent.click(screen.getByRole('button', { name: /Keep their places as a list/ }))
    expect(onKeepAsList).toHaveBeenCalled()
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

  it('a layer per type found: the kinds the view holds, most common first', async () => {
    renderSheet()
    expect(askedTypes).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: /A layer per type found/ }))
    // Asked of what the view finds, where it looks.
    expect(askedTypes).toHaveBeenLastCalledWith('v-base', pii, false)
    save()
    await waitFor(() => expect(createFromSearch).toHaveBeenCalledTimes(1))
    expect(createFromSearch.mock.calls[0][0]).toMatchObject({ layout: 'own' })
    expect(createFromSearch.mock.calls[0][0].layers?.flatMap((l) => l.entityTypes)).toEqual(['column', 'table'])
  })

  it('a layer per type waits for the kinds it holds, and says when they can’t be found', () => {
    breakdownOf = () => ({ status: 'loading' })
    renderSheet()
    fireEvent.click(screen.getByRole('radio', { name: /A layer per type found/ }))
    expect(screen.getByRole('status')).toHaveTextContent('Finding the kinds of entity it holds')
    expect(screen.getByRole('button', { name: /Save view/ })).toBeDisabled()
    cleanup()
    breakdownOf = () => ({ status: 'error' })
    renderSheet()
    fireEvent.click(screen.getByRole('radio', { name: /A layer per type found/ }))
    expect(screen.getByRole('status')).toHaveTextContent('Couldn’t tell what kinds it holds')
    expect(screen.getByRole('button', { name: /Save view/ })).toBeDisabled()
  })

  it('leaves layers out only while it follows its base', async () => {
    renderSheet()
    fireEvent.click(screen.getByRole('switch', { name: 'Leave out Dashboards' }))
    expect(screen.getByText('left out')).toBeInTheDocument()
    // A copy of the layers, or a layer per type, is an own layout: it shows every layer it has.
    fireEvent.click(screen.getByRole('radio', { name: 'The whole data source' }))
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByText('left out')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Sales overview' }))
    fireEvent.click(screen.getByRole('radio', { name: /A layer per type found/ }))
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    // Back to following it: what was left out still is.
    fireEvent.click(screen.getByRole('radio', { name: /Like “Sales overview”/ }))
    expect(screen.getByRole('switch', { name: 'Keep Dashboards' })).toHaveAttribute('aria-checked', 'false')
    save()
    await waitFor(() => expect(createFromSearch).toHaveBeenCalled())
    expect(createFromSearch.mock.calls[0][0]).toMatchObject({ layout: 'inherit', hiddenLayers: ['l2'] })
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

  it('keeps what the matches reach, counted in the preview and sent with the save', async () => {
    renderSheet()
    fireEvent.click(screen.getByRole('button', { name: /Everything inside them/ }))
    fireEvent.click(screen.getByRole('button', { name: /What feeds them/ }))
    expect(screen.getByRole('button', { name: /Everything inside them/ })).toHaveAttribute('aria-pressed', 'true')
    expect(JSON.stringify(counted.mock.calls.at(-1)![0])).toContain('"axis":"ancestor"')
    expect(screen.getByText(/everything inside them and what feeds them/)).toBeInTheDocument()
    save()
    await waitFor(() => expect(createFromSearch).toHaveBeenCalled())
    expect(createFromSearch.mock.calls[0][0].include).toEqual(
      { contents: true, containers: false, upstream: true, downstream: false })
  })

  it('keeps a number of levels inside them, and what contains them a number up — counted, said and sent', async () => {
    renderSheet()
    expect(screen.queryByRole('radiogroup', { name: 'Levels inside them' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Everything inside them/ }))
    const inside = screen.getByRole('radiogroup', { name: 'Levels inside them' })
    expect(within(inside).getAllByRole('radio').map((r) => r.textContent)).toEqual(['1', '2', '3', 'All'])
    expect(within(inside).getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(inside).getByRole('radio', { name: '2' }))
    expect(found()).toEqual({ kind: 'group', op: 'or', children: [pii, { kind: 'related', axis: 'ancestor', where: pii, maxHops: 2 }] })
    expect(screen.getByRole('button', { name: /Everything inside them/ })).toHaveTextContent('Two levels in')

    fireEvent.click(screen.getByRole('button', { name: /What contains them/ }))
    const up = screen.getByRole('radiogroup', { name: 'Levels up' })
    expect(within(up).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Parent', '2', '3', 'Top'])
    expect(within(up).getByRole('radio', { name: 'Top' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(up).getByRole('radio', { name: 'Parent' }))
    expect(found()).toEqual({ kind: 'group', op: 'or', children: [pii,
      { kind: 'related', axis: 'ancestor', where: pii, maxHops: 2 },
      { kind: 'related', axis: 'descendant', where: pii, maxHops: 1 }] })
    expect(screen.getByRole('button', { name: /What contains them/ })).toHaveTextContent('One level up')
    expect(screen.getByText('two levels inside them and what contains them, one level up')).toBeInTheDocument()
    save()
    await waitFor(() => expect(createFromSearch).toHaveBeenCalled())
    expect(createFromSearch.mock.calls[0][0].include).toStrictEqual(
      { contents: true, contentsLevels: 2, containers: true, containersLevels: 1, upstream: false, downstream: false })
  })

  it('keeps only some kinds inside them, of the view’s kinds — counted, said and sent as a set', async () => {
    renderSheet()
    fireEvent.click(screen.getByRole('button', { name: /Everything inside them/ }))
    const only = screen.getByRole('button', { name: 'Only these kinds inside them' })
    expect(only).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('group', { name: 'Only these kinds inside them' })).toBeNull()
    fireEvent.click(only)
    const chips = screen.getByRole('group', { name: 'Only these kinds inside them' })
    expect(chips).toHaveTextContent('None chosen: every kind')
    fireEvent.click(within(chips).getByRole('button', { name: 'Table' }))
    fireEvent.click(within(chips).getByRole('button', { name: 'Column' }))
    expect(within(chips).getByRole('button', { name: 'Column' })).toHaveAttribute('aria-pressed', 'true')
    expect(found()).toEqual({ kind: 'group', op: 'or', children: [pii, { kind: 'group', op: 'and', children: [
      { kind: 'entityType', op: 'in', values: ['column', 'table'] }, { kind: 'related', axis: 'ancestor', where: pii }] }] })
    expect(screen.getByText('everything inside them (only Column or Table)')).toBeInTheDocument()
    // Collapsed again, it still says how many it keeps.
    fireEvent.click(only)
    expect(only).toHaveTextContent('2')
    save()
    await waitFor(() => expect(createFromSearch).toHaveBeenCalled())
    expect(createFromSearch.mock.calls[0][0].include).toStrictEqual(
      { contents: true, contentsKinds: ['column', 'table'], containers: false, upstream: false, downstream: false })
  })

  it('every level is asked by leaving levels out, and a choice turned off takes its levels with it', async () => {
    renderSheet()
    const contents = () => screen.getByRole('button', { name: /Everything inside them/ })
    fireEvent.click(contents())
    const inside = screen.getByRole('radiogroup', { name: 'Levels inside them' })
    fireEvent.click(within(inside).getByRole('radio', { name: '3' }))
    expect(contents()).toHaveTextContent('Three levels in')
    fireEvent.click(within(inside).getByRole('radio', { name: 'All' }))
    expect(found()).toEqual({ kind: 'group', op: 'or', children: [pii, { kind: 'related', axis: 'ancestor', where: pii }] })
    expect(JSON.stringify(found())).not.toContain('maxHops')
    expect(contents()).toHaveTextContent('However deep')

    fireEvent.click(within(inside).getByRole('radio', { name: '2' }))
    fireEvent.click(contents())
    await waitFor(() => expect(screen.queryByRole('radiogroup', { name: 'Levels inside them' })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: /What feeds them/ }))
    expect(JSON.stringify(found())).not.toContain('maxHops')
    save()
    await waitFor(() => expect(createFromSearch).toHaveBeenCalled())
    expect(createFromSearch.mock.calls[0][0].include).toStrictEqual(
      { contents: false, containers: false, upstream: true, downstream: false })
  })

  it('leaves a layer out, with its matches — but never the last one', async () => {
    renderSheet()
    fireEvent.click(screen.getByRole('switch', { name: 'Leave out Dashboards' }))
    expect(screen.getByText('left out')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: 'Leave out Other matches' }))
    expect(screen.getByRole('switch', { name: 'Leave out Tables' })).toBeDisabled()
    save()
    await waitFor(() => expect(createFromSearch).toHaveBeenCalled())
    expect(createFromSearch.mock.calls[0][0]).toMatchObject({ layout: 'inherit', hiddenLayers: ['l2', 'other-matches'] })
  })

  it('offers to narrow first for more reach, and shows what goes beside the title', () => {
    const onNarrowInstead = vi.fn()
    renderSheet({ onNarrowInstead, headerExtra: <span>Keep as a list instead</span> })
    expect(screen.getByText('Keep as a list instead')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Narrow first' }))
    expect(onNarrowInstead).toHaveBeenCalled()
  })
})
