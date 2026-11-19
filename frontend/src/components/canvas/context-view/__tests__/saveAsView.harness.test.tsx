/**
 * Save as view on the REAL Context View canvas: narrow to an entity, then keep
 * the narrowing as a view of its own. The Narrowed bar offers it to whoever may
 * create views here; the sheet previews what the view would start with through
 * the graph provider, and saves the narrowing's own spec, searched in this view.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FromMembersRequest, MembershipPlan, MembershipRequest, MembershipResult, PlanRequest } from '@/types/membership'

const createFromMembers = vi.fn<(body: FromMembersRequest, key: string) => Promise<unknown>>()
vi.mock('@/services/liveViewsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/liveViewsApi')>()),
  createFromMembers: (b: FromMembersRequest, k: string) => createFromMembers(b, k),
}))

import { useNarrowStore } from '@/features/narrow/narrowStore'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { useAuthStore } from '@/store/auth'
import { useFeaturesStore } from '@/store/features'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'

const ONE_LEVEL_IN: MembershipResult = {
  specHash: 'h1',
  members: [{ urn: 'INTERMEDIATE_T2', via: 'seed' }, { urn: 'orders', via: 'inside' }],
  wholeSubtree: [],
  chains: { INTERMEDIATE_T2: ['snowflake'], orders: ['INTERMEDIATE_T2', 'snowflake'] },
  counts: { seeds: 1, inside: 1, upstream: 0, downstream: 0, partnerInside: 0, total: 2 },
  missingSeeds: 0, truncated: [], dataVersion: '1', elapsedMs: 3,
}

const PLAN: MembershipPlan = {
  keys: 3, members: 2, containers: 1, included: 0, limit: 5000, overCap: false,
  layers: [{ id: 'n1', name: 'Warehouse', color: '#3b82f6', count: 3, linkLayerId: 'l1', kept: true }],
  fallback: 0, truncated: [], missingSeeds: 0, dataVersion: '1',
}

function setPreview(on: boolean) {
  useFeaturesStore.setState({
    values: { ...useFeaturesStore.getState().values, viewMembershipEnabled: on, traceEnabled: true },
  } as never)
}

const card = (id: string) => {
  const el = document.getElementById(`layer-node-${id}`)
  if (!el) throw new Error(`no card ${id}`)
  return el
}

describe('Save as view from a narrowed canvas', () => {
  afterEach(() => {
    useNarrowStore.getState().clear()
    setPreview(false)
    useAuthStore.setState({ permissions: { sid: '', global: [], ws: {} } } as never)
    createFromMembers.mockReset()
  })

  it('keeps the narrowing as a view of its own', async () => {
    setPreview(true)
    useAuthStore.setState({ permissions: { sid: 's', global: [], ws: { 'harness-ws': ['workspace:view:create'] } } } as never)
    const planned: PlanRequest[] = []
    createFromMembers.mockResolvedValue({ view: { id: 'v-new', name: 'INTERMEDIATE_T2' }, membership: {} })
    const h = await renderCanvasWithTrace(cfoEstate(), {
      focus: 'cfo',
      deferTrace: true,
      wrapProvider: (p) => ({
        ...p,
        resolveMembers: async (_v: string, _r: MembershipRequest) => ONE_LEVEL_IN,
        planMembers: async (_v: string, r: PlanRequest) => { planned.push(r); return PLAN },
      }) as GraphDataProvider,
    })

    await act(async () => { fireEvent.contextMenu(card('INTERMEDIATE_T2')) })
    await h.settle()
    await act(async () => { fireEvent.click(screen.getByText('Narrow to this…')) })
    await h.settle()
    await act(async () => { fireEvent.click(screen.getByText('One level in')) })
    await waitFor(() => expect(screen.getByRole('status', { name: 'The canvas is narrowed' })).toBeInTheDocument(), { timeout: 8000 })

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save as view/ })) })
    expect(await screen.findByRole('dialog', { name: 'Save as a view' })).toBeInTheDocument()
    expect((await screen.findAllByText(/2 entities \+ 1 container = 3 of 5,000/, {}, { timeout: 5000 })).length).toBeGreaterThan(0)
    expect(planned.at(-1)).toMatchObject({
      sources: [{ spec: { seeds: { urns: ['INTERMEDIATE_T2'] }, expand: { children: 1 } } }],
      layout: { kind: 'source', sourceViewId: 'harness-view' },
    })

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save view/ })) })
    await waitFor(() => expect(createFromMembers).toHaveBeenCalledOnce())
    expect(createFromMembers.mock.calls[0][0]).toMatchObject({ workspaceId: 'harness-ws', mode: 'live' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save as a view' })).toBeNull())
  }, 40000)

  it('is not offered to someone who may not create views here', async () => {
    setPreview(true)
    const h = await renderCanvasWithTrace(cfoEstate(), {
      focus: 'cfo',
      deferTrace: true,
      wrapProvider: (p) => ({ ...p, resolveMembers: async () => ONE_LEVEL_IN }) as GraphDataProvider,
    })
    await act(async () => { fireEvent.contextMenu(card('INTERMEDIATE_T2')) })
    await h.settle()
    await act(async () => { fireEvent.click(screen.getByText('Narrow to this…')) })
    await h.settle()
    await act(async () => { fireEvent.click(screen.getByText('One level in')) })
    await waitFor(() => expect(screen.getByRole('status', { name: 'The canvas is narrowed' })).toBeInTheDocument(), { timeout: 8000 })
    expect(screen.queryByRole('button', { name: /Save as view/ })).toBeNull()
  }, 40000)
})

// A TRACE kept as a view: the dock's Export & save offers it, and the view is
// the trace's own question — these seeds, this far each way — resolved by the
// server, laid out as lineage stages.
describe('Save as view from a trace', () => {
  afterEach(() => {
    setPreview(false)
    useAuthStore.setState({ permissions: { sid: '', global: [], ws: {} } } as never)
    createFromMembers.mockReset()
  })

  const openFromDock = async () => {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Export and save this trace' })) })
    const panel = screen.getByRole('dialog', { name: 'Export and save this trace' })
    return panel.querySelector<HTMLButtonElement>('[data-keep="view"]')
  }

  it('saves the trace’s seeds and reach, origin trace', async () => {
    setPreview(true)
    useAuthStore.setState({ permissions: { sid: 's', global: [], ws: { 'harness-ws': ['workspace:view:create'] } } } as never)
    const planned: PlanRequest[] = []
    const askedIn: string[] = []
    createFromMembers.mockResolvedValue({ view: { id: 'v-new', name: 'cfo' }, membership: {} })
    const h = await renderCanvasWithTrace(cfoEstate(), {
      focus: 'cfo',
      wrapProvider: (p) => ({
        ...p,
        planMembers: async (v: string, r: PlanRequest) => { askedIn.push(v); planned.push(r); return PLAN },
      }) as GraphDataProvider,
    })
    await h.startTrace('cfo')
    await h.setDirection('up')

    const offer = await openFromDock()
    expect(offer).toBeTruthy()
    await act(async () => { fireEvent.click(offer!) })
    expect(await screen.findByRole('dialog', { name: 'Save as a view' })).toBeInTheDocument()
    await waitFor(() => expect(planned.length).toBeGreaterThan(0))
    // Upstream only: a side switched off is no reach; the walk's ceiling is the whole way. It
    // follows the view it was traced in, as a subset of it.
    expect(planned.at(-1)).toMatchObject({
      sources: [{ spec: { seeds: { urns: ['cfo'] }, expand: { upstream: 'all', downstream: 0, children: 'all', partnerChildren: 0 } } }],
      layout: { kind: 'follow', sourceViewId: askedIn.at(-1), nest: true },
    })

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save view/ })) })
    await waitFor(() => expect(createFromMembers).toHaveBeenCalledOnce())
    expect(createFromMembers.mock.calls[0][0]).toMatchObject({ provenance: { origin: 'trace' } })
  }, 40000)

  it('is not offered to someone who may not create views here', async () => {
    setPreview(true)
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    await h.startTrace('cfo')
    expect(await openFromDock()).toBeNull()
  }, 40000)
})
