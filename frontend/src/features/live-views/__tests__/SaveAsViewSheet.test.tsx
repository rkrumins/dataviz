/**
 * SaveAsViewSheet — a narrowing kept as a view of its own: the layout it starts
 * with, previewed layer by layer against the limit, and saved only when it fits.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FromMembersRequest, MembershipPlan, PlanRequest } from '@/types/membership'

const planMembers = vi.fn<(viewId: string, req: PlanRequest) => Promise<MembershipPlan>>()
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
})
