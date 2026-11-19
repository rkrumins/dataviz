/**
 * SaveAsViewSheet — a narrowing kept as a view of its own: the layout it starts
 * with, previewed layer by layer against the limit, and saved only when it fits.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FromMembersRequest, MembershipPlan, MembershipResolving, PlanRequest } from '@/types/membership'

const planMembers = vi.fn<(viewId: string, req: PlanRequest) => Promise<MembershipPlan | MembershipResolving>>()
const createFromMembers = vi.fn<(body: FromMembersRequest, key: string) => Promise<unknown>>()

vi.mock('@/providers', () => ({ useGraphProvider: () => ({ planMembers }) }))
vi.mock('@/services/liveViewsApi', () => ({ createFromMembers: (b: FromMembersRequest, k: string) => createFromMembers(b, k) }))
vi.mock('@/hooks/useLayoutTemplates', () => ({
  useLayoutTemplatesEnabled: () => true,
  useLayoutTemplates: () => ({
    templates: [{ id: 'tpl', name: 'Medallion', layers: [{ id: 'b', name: 'Bronze', entityTypes: ['table'] }] }],
    isLoading: false,
    error: null,
  }),
}))
vi.mock('@/store/schema', () => ({ useSchemaEntityTypes: () => [{ id: 'table' }] }))

import { specFor } from '@/features/narrow/model'

import { SaveAsViewSheet } from '../SaveAsViewSheet'

function plan(over: Partial<MembershipPlan> = {}): MembershipPlan {
  return {
    keys: 6, members: 6, containers: 0, included: 0, limit: 5000, overCap: false,
    layers: [
      { id: 'n1', name: 'Tables', color: '#3b82f6', count: 2, linkLayerId: 'l1', kept: true },
      { id: 'n2', name: 'Dashboards', color: '#ef4444', count: 0, linkLayerId: 'l2', kept: false },
    ],
    fallback: 0, truncated: [], missingSeeds: 0, dataVersion: '1', ...over,
  }
}

function renderSheet(over: Partial<Parameters<typeof SaveAsViewSheet>[0]> = {}) {
  const props = {
    viewId: 'v1',
    viewName: 'Sales overview',
    workspaceId: 'ws',
    dataSourceId: 'ds',
    draft: { spec: specFor({ urns: ['orders'] }, { children: 1 }), seedsLabel: 'orders' },
    sourceLayerCount: 3,
    onClose: vi.fn(),
    onSaved: vi.fn(),
    ...over,
  }
  render(<SaveAsViewSheet {...props} />)
  return props
}

describe('SaveAsViewSheet', () => {
  beforeEach(() => {
    planMembers.mockReset()
    createFromMembers.mockReset()
    planMembers.mockResolvedValue(plan())
  })

  it('previews the layers it would start with, like the view it came from', async () => {
    renderSheet()
    expect((await screen.findAllByText('6 entities of 5,000')).length).toBe(2)
    expect(screen.getByText('Tables')).toBeInTheDocument()
    expect(screen.getByText('left out')).toBeInTheDocument()
    expect(planMembers.mock.calls.at(-1)![1].layout).toEqual({ kind: 'source', sourceViewId: 'v1', nest: true })
    expect(screen.getByRole('radio', { name: /Lineage stages/ })).toBeDisabled()
  })

  it('asks again as the layout changes, and waits for a template to be chosen', async () => {
    renderSheet()
    await screen.findAllByText('6 entities of 5,000')
    fireEvent.click(screen.getByRole('radio', { name: /By type/ }))
    await waitFor(() => expect(planMembers.mock.calls.at(-1)![1].layout.kind).toBe('auto'))
    fireEvent.click(screen.getByRole('radio', { name: /From a template/ }))
    expect(await screen.findByText(/Choose a template/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /Medallion/ }))
    await waitFor(() => expect(planMembers.mock.calls.at(-1)![1].layout).toMatchObject({ kind: 'template', templateId: 'tpl' }))
    expect(planMembers.mock.calls.at(-1)![1].layers).toHaveLength(1)
  })

  it('a large set is worked out on the server: it says how far it has got, and carries on', async () => {
    const counts = { seeds: 20, inside: 0, upstream: 30_000, downstream: 11_000, partnerInside: 0, total: 41_020 }
    const resolving: MembershipResolving = { status: 'resolving', sets: [{
      setId: 'ms_1', specHash: 'h', status: 'running', stage: 'downstream', counts, missingSeeds: 0, truncated: [],
      dataVersion: '1', progress: { steps: 12, queued: 40 }, startedAt: '',
    }] }
    let asked = 0
    planMembers.mockImplementation(() => new Promise((resolve) => {
      asked += 1
      // The first ask answers 202; the next one is held, so the progress stays on screen.
      if (asked === 1) resolve(resolving)
    }))
    renderSheet()
    expect(await screen.findByText(/Working out everything it reaches — 41,020 entities so far/)).toBeInTheDocument()
    await waitFor(() => expect(asked).toBe(2))
    // No wait is sent: the server's own applies, and an older server still answers.
    expect(planMembers.mock.calls[0][1]).not.toHaveProperty('waitMs')
  })

  it('over the limit, says why and what helps, and will not save', async () => {
    planMembers.mockResolvedValue(plan({ overCap: true, keys: 5300, members: 4900, containers: 400 }))
    renderSheet()
    expect(await screen.findByText(/More than a view can hold/)).toBeInTheDocument()
    expect(screen.getByText(/4,900, which fits/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Save view/ })).toBeDisabled()
  })

  it('saves an auto-updating view with the choices made, once, and hands it back', async () => {
    const view = { id: 'v2', name: 'Orders' }
    createFromMembers.mockResolvedValue({ view, membership: {} })
    const props = renderSheet()
    await screen.findAllByText('6 entities of 5,000')
    fireEvent.change(screen.getByRole('textbox', { name: 'View name' }), { target: { value: 'Orders' } })
    fireEvent.click(screen.getByRole('radio', { name: /The workspace/ }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter', metaKey: true })
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledWith(view))
    const [body, key] = createFromMembers.mock.calls[0]
    expect(body).toMatchObject({
      name: 'Orders', visibility: 'workspace', mode: 'live', workspaceId: 'ws', dataSourceId: 'ds',
      layout: { kind: 'source', sourceViewId: 'v1', nest: true }, keep: 'withResults',
      provenance: { origin: 'narrow', viewId: 'v1' },
    })
    expect(key).toBeTruthy()
  })

  it('a snapshot is saved as one, and a refusal is said in the server’s words', async () => {
    createFromMembers.mockRejectedValue(Object.assign(new Error('x'), { status: 422, detail: { message: 'This would hold 9,000 entries.' } }))
    renderSheet()
    await screen.findAllByText('6 entities of 5,000')
    fireEvent.click(screen.getByRole('switch', { name: /Keeps itself up to date/ }))
    expect(screen.getByText('A snapshot')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Save view/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This would hold 9,000 entries.')
    expect(createFromMembers.mock.calls[0][0].mode).toBe('snapshot')
  })

  const traceDraft = {
    spec: specFor({ urns: ['orders', 'sales'] }, { upstream: 'all', downstream: 2 }),
    seedsLabel: '2 entities', origin: 'trace' as const,
  }

  it('a trace starts as a subset that follows the view it was traced in, and saves as one', async () => {
    createFromMembers.mockResolvedValue({ view: { id: 'v2', name: 'Orders trace' }, membership: {} })
    renderSheet({ draft: traceDraft, follow: { viewId: 'v1', viewName: 'Sales overview' } })
    await screen.findAllByText('6 entities of 5,000')
    expect(screen.getByRole('radio', { name: /Follow “Sales overview”/ })).toBeChecked()
    expect(planMembers.mock.calls.at(-1)![1].layout).toEqual({ kind: 'follow', sourceViewId: 'v1', nest: true })
    fireEvent.change(screen.getByRole('textbox', { name: 'View name' }), { target: { value: 'Orders trace' } })
    fireEvent.click(screen.getByRole('button', { name: /Save view/ }))
    await waitFor(() => expect(createFromMembers).toHaveBeenCalled())
    expect(createFromMembers.mock.calls[0][0].layout).toEqual({ kind: 'follow', sourceViewId: 'v1', nest: true })
  })

  it('in a subset, it follows that subset’s base, and "Like" copies the base’s layers — the ones it shows', async () => {
    renderSheet({ viewId: 'sub1', viewName: 'Orders subset', draft: traceDraft, follow: { viewId: 'base', viewName: 'Sales overview' } })
    await screen.findAllByText('6 entities of 5,000')
    expect(planMembers.mock.calls.at(-1)![0]).toBe('sub1')
    expect(planMembers.mock.calls.at(-1)![1].layout).toEqual({ kind: 'follow', sourceViewId: 'base', nest: true })
    fireEvent.click(screen.getByRole('radio', { name: /Like “Sales overview”/ }))
    await waitFor(() => expect(planMembers.mock.calls.at(-1)![1].layout).toEqual({ kind: 'source', sourceViewId: 'base', nest: true }))
  })

  it('a trace can bring in what is inside the tables it reaches, and their lineage too — each a new preview', async () => {
    renderSheet({ draft: traceDraft, follow: { viewId: 'v1', viewName: 'Sales overview' } })
    await screen.findAllByText('6 entities of 5,000')
    // By default it asks as ever: nothing new in the request.
    expect(planMembers.mock.calls.at(-1)![1].sources[0]!.spec.expand).toEqual(traceDraft.spec.expand)
    expect(screen.queryByRole('switch', { name: 'Their lineage too' })).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'One level' }))
    await waitFor(() => expect(planMembers.mock.calls.at(-1)![1].sources[0]!.spec.expand)
      .toEqual({ ...traceDraft.spec.expand, partnerChildren: 1, partnerHosts: true }))
    fireEvent.click(screen.getByRole('switch', { name: 'Their lineage too' }))
    await waitFor(() => expect(planMembers.mock.calls.at(-1)![1].sources[0]!.spec.expand)
      .toMatchObject({ partnerChildren: 1, partnerHosts: true, partnerLineage: true }))
    expect(screen.getByText(/their lineage too/)).toBeInTheDocument()
  })

  it('a narrowing has no such choice; an older server refusing one says which field', async () => {
    renderSheet()
    await screen.findAllByText('6 entities of 5,000')
    expect(screen.queryByText('Inside what it reaches')).toBeNull()
    planMembers.mockRejectedValue(Object.assign(new Error('x'), {
      status: 422, detail: [{ type: 'extra_forbidden', loc: ['body', 'sources', 0, 'spec', 'expand', 'partnerHosts'], msg: 'Extra inputs are not permitted' }],
    }))
    cleanup()
    renderSheet({ draft: traceDraft })
    fireEvent.click(await screen.findByRole('radio', { name: 'Everything' }))
    expect(await screen.findByText(/Extra inputs are not permitted \(partnerHosts\)/)).toBeInTheDocument()
  })

  it('when there is nothing to follow, says why and starts a trace with its lineage stages', async () => {
    renderSheet({ draft: traceDraft, follow: { reason: 'This view is made from a query' } })
    await screen.findAllByText('6 entities of 5,000')
    expect(screen.getByRole('radio', { name: /Follow/ })).toBeDisabled()
    expect(screen.getByText('This view is made from a query')).toBeInTheDocument()
    expect(planMembers.mock.calls.at(-1)![1].layout.kind).toBe('stages')
  })
})
