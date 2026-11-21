/**
 * ReusableChangesPanel — the view's reusable changes, each run (the bulk dialog opened with the whole
 * change), renamed or deleted; and, when asked, those of the workspace's other views, to run here.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ put: vi.fn(), remove: vi.fn(), others: vi.fn() }))
vi.mock('@/services/viewLibraryService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/viewLibraryService')>()),
  putReusableChange: api.put,
  deleteReusableChange: api.remove,
  listReusableChangesFromOtherViews: api.others,
}))
const editing = vi.hoisted(() => ({ offered: true, blocked: null as string | null }))
vi.mock('@/features/versioning/hooks/useEntityEditing', () => ({ useEntityEditing: () => editing }))

import { useNotificationStore } from '@/components/ui/notifications'
import type { ReusableChange } from '@/services/viewLibraryService'
import { usePropertyJobsStore } from '@/store/propertyJobsStore'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useViewLibraryStore } from '@/store/viewLibraryStore'
import type { ViewLayerConfig } from '@/types/schema'
import { ReusableChangesPanel } from '../ReusableChangesPanel'

const tidy: ReusableChange = {
  id: 'r1', name: 'Tidy owners', description: 'After each import',
  op: { kind: 'normalize', key: 'owner', onConflict: 'skip', trim: true, collapseSpaces: true, case: 'lower', dedupeList: false },
  target: { kind: 'layer', layerName: 'Silver', scopeMode: 'view' },
}
const own: ReusableChange = {
  id: 'r2', name: 'Own them', op: { kind: 'set', key: 'owner', value: 'data-team', onConflict: 'skip' },
  target: { kind: 'hasKey', key: 'owner', scopeMode: 'data_source' },
}

const row = (name: string) => screen.getByText(name).closest('li')!
const seed = () => usePropertyJobsStore.getState().request

beforeEach(() => {
  api.put.mockReset().mockImplementation(async (_view: string, id: string, body: object) => ({ id, ...body }))
  api.remove.mockReset().mockResolvedValue(undefined)
  api.others.mockReset().mockResolvedValue([])
  editing.offered = true
  editing.blocked = null
  useViewLibraryStore.setState({ viewId: 'v1', branchId: null, status: 'ready', canEdit: true, reusableChanges: [tidy, own] })
  useReferenceModelStore.setState({ layers: [{ id: 'L1', name: 'Gold' }, { id: 'L2', name: 'Silver' }] as ViewLayerConfig[] })
  usePropertyJobsStore.setState({ request: null, requestSeq: 0 })
  useNotificationStore.setState({ notifications: [] })
})

describe('ReusableChangesPanel', () => {
  it('lists the view’s reusable changes: the change, and where it reaches — the whole data source as a badge, all of it on hover', async () => {
    const user = userEvent.setup()
    render(<ReusableChangesPanel viewId="v1" />)
    expect(screen.getByRole('heading', { name: 'Reusable changes · 2' })).toBeInTheDocument()
    expect(within(row('Tidy owners')).getByText(/Normalize owner .* on the Silver layer/)).toBeInTheDocument()
    expect(within(row('Tidy owners')).queryByText('Whole data source')).toBeNull()
    expect(within(row('Own them')).getByText('Set owner · on every entity with owner')).toBeInTheDocument()
    expect(within(row('Own them')).getByText('Whole data source')).toBeInTheDocument()
    await user.hover(within(row('Own them')).getByText('Set owner · on every entity with owner'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Own themSet owner · on every entity with owner, across the whole data source')
  })

  it('runs one: the dialog opens with the whole change, its layer found by name here', async () => {
    const user = userEvent.setup()
    render(<ReusableChangesPanel viewId="v1" />)
    await user.click(within(row('Tidy owners')).getByRole('button', { name: 'Run “Tidy owners”' }))
    expect(seed()).toEqual({ op: tidy.op, target: { kind: 'layer', layerId: 'L2', name: 'Silver' }, reusable: { name: 'Tidy owners' } })
    await user.click(within(row('Own them')).getByRole('button', { name: 'Run “Own them”' }))
    expect(seed()).toEqual({ op: own.op, target: { kind: 'hasKey', key: 'owner' }, scopeMode: 'data_source', reusable: { name: 'Own them' } })
  })

  it('says when this view has no layer by the change’s name, and leaves the dialog to ask where', async () => {
    const user = userEvent.setup()
    useReferenceModelStore.setState({ layers: [{ id: 'L1', name: 'Gold' }] as ViewLayerConfig[] })
    render(<ReusableChangesPanel viewId="v1" />)
    await user.click(within(row('Tidy owners')).getByRole('button', { name: 'Run “Tidy owners”' }))
    expect(seed()).toEqual({ op: tidy.op, reusable: { name: 'Tidy owners' } })
    expect(useNotificationStore.getState().notifications.map((n) => n.message)).toEqual([
      'This view has no layer named “Silver” — choose where “Tidy owners” should apply.',
    ])
  })

  it('renames one in place', async () => {
    const user = userEvent.setup()
    render(<ReusableChangesPanel viewId="v1" />)
    await user.click(within(row('Own them')).getByRole('button', { name: 'Rename' }))
    const input = screen.getByRole('textbox', { name: 'New name for “Own them”' })
    await user.clear(input)
    await user.type(input, 'Own every one{Enter}')
    expect(api.put).toHaveBeenCalledWith('v1', 'r2', {
      name: 'Own every one', description: null, op: own.op, target: own.target,
    })
    expect(await screen.findByText('Own every one')).toBeInTheDocument()
  })

  it('deletes one for everyone — once asked', async () => {
    const user = userEvent.setup()
    render(<ReusableChangesPanel viewId="v1" />)
    await user.click(within(row('Own them')).getByRole('button', { name: 'Delete' }))
    expect(api.remove).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Delete reusable change' }))
    expect(api.remove).toHaveBeenCalledWith('v1', 'r2')
    expect(screen.queryByText('Own them')).not.toBeInTheDocument()
  })

  it('leaves renaming and deleting to people who can edit the library', () => {
    useViewLibraryStore.setState({ canEdit: false })
    render(<ReusableChangesPanel viewId="v1" />)
    expect(within(row('Own them')).getByRole('button', { name: 'Run “Own them”' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('says why a reusable change can’t run yet', async () => {
    const user = userEvent.setup()
    editing.blocked = 'Switch to a draft to make changes'
    render(<ReusableChangesPanel viewId="v1" />)
    const run = within(row('Own them')).getByRole('button', { name: 'Run “Own them”' })
    expect(run).toBeDisabled()
    await user.hover(run.parentElement!)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Switch to a draft to make changes')
  })

  it('shows nothing where no change can be made and the view keeps no reusable change', () => {
    editing.offered = false
    useViewLibraryStore.setState({ reusableChanges: [] })
    const { container } = render(<ReusableChangesPanel viewId="v1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('runs a reusable change from another view, said to be over another data source', async () => {
    const user = userEvent.setup()
    api.others.mockResolvedValueOnce([{ viewId: 'v9', viewName: 'Finance', sameSource: false, change: own }])
    useViewLibraryStore.setState({ reusableChanges: [] })
    render(<ReusableChangesPanel viewId="v1" />)
    await user.click(screen.getByRole('button', { name: 'Reusable changes from other views' }))
    const group = await screen.findByRole('region', { name: 'Reusable changes from Finance' })
    expect(api.others).toHaveBeenCalledWith('v1', expect.any(AbortSignal))
    expect(within(group).getByText(/Another data source/)).toBeInTheDocument()
    await user.click(within(group).getByRole('button', { name: 'Run “Own them”' }))
    expect(seed()).toEqual({ op: own.op, target: { kind: 'hasKey', key: 'owner' }, scopeMode: 'data_source', reusable: { name: 'Own them' } })
  })

  it('says when the other views couldn’t be read, and tries again', async () => {
    const user = userEvent.setup()
    api.others.mockRejectedValueOnce(new Error('Service Unavailable'))
    render(<ReusableChangesPanel viewId="v1" />)
    await user.click(screen.getByRole('button', { name: 'From other views' }))
    expect(await screen.findByText('Couldn’t look through the other views')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('No reusable changes on other views yet')).toBeInTheDocument()
    expect(api.others).toHaveBeenCalledTimes(2)
  })
})
