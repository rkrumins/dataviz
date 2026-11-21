/**
 * RecipesPanel — the view's bulk recipes, each run (the bulk dialog opened with the whole change),
 * renamed or deleted; and, when asked, the recipes of the workspace's other views, to run here.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ put: vi.fn(), remove: vi.fn(), others: vi.fn() }))
vi.mock('@/services/viewLibraryService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/viewLibraryService')>()),
  putViewRecipe: api.put,
  deleteViewRecipe: api.remove,
  listRecipesFromOtherViews: api.others,
}))
const editing = vi.hoisted(() => ({ offered: true, blocked: null as string | null }))
vi.mock('@/features/versioning/hooks/useEntityEditing', () => ({ useEntityEditing: () => editing }))

import { useNotificationStore } from '@/components/ui/notifications'
import type { BulkRecipe } from '@/services/viewLibraryService'
import { usePropertyJobsStore } from '@/store/propertyJobsStore'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useViewLibraryStore } from '@/store/viewLibraryStore'
import type { ViewLayerConfig } from '@/types/schema'
import { RecipesPanel } from '../RecipesPanel'

const tidy: BulkRecipe = {
  id: 'r1', name: 'Tidy owners', description: 'After each import',
  op: { kind: 'normalize', key: 'owner', onConflict: 'skip', trim: true, collapseSpaces: true, case: 'lower', dedupeList: false },
  target: { kind: 'layer', layerName: 'Silver', scopeMode: 'view' },
}
const own: BulkRecipe = {
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
  useViewLibraryStore.setState({ viewId: 'v1', branchId: null, status: 'ready', canEdit: true, bulkRecipes: [tidy, own] })
  useReferenceModelStore.setState({ layers: [{ id: 'L1', name: 'Gold' }, { id: 'L2', name: 'Silver' }] as ViewLayerConfig[] })
  usePropertyJobsStore.setState({ request: null, requestSeq: 0 })
  useNotificationStore.setState({ notifications: [] })
})

describe('RecipesPanel', () => {
  it('lists the view’s recipes: the change, and where it reaches', () => {
    render(<RecipesPanel viewId="v1" />)
    expect(screen.getByRole('heading', { name: 'Recipes · 2' })).toBeInTheDocument()
    expect(within(row('Tidy owners')).getByText(/Normalize owner .* on the Silver layer/)).toBeInTheDocument()
    expect(within(row('Own them')).getByText('Set owner · on every entity with owner, across the whole data source')).toBeInTheDocument()
  })

  it('runs one: the dialog opens with the whole change, its layer found by name here', async () => {
    const user = userEvent.setup()
    render(<RecipesPanel viewId="v1" />)
    await user.click(within(row('Tidy owners')).getByRole('button', { name: 'Run “Tidy owners”' }))
    expect(seed()).toEqual({ op: tidy.op, target: { kind: 'layer', layerId: 'L2', name: 'Silver' } })
    await user.click(within(row('Own them')).getByRole('button', { name: 'Run “Own them”' }))
    expect(seed()).toEqual({ op: own.op, target: { kind: 'hasKey', key: 'owner' }, scopeMode: 'data_source' })
  })

  it('says when this view has no layer by the recipe’s name, and leaves the dialog to ask where', async () => {
    const user = userEvent.setup()
    useReferenceModelStore.setState({ layers: [{ id: 'L1', name: 'Gold' }] as ViewLayerConfig[] })
    render(<RecipesPanel viewId="v1" />)
    await user.click(within(row('Tidy owners')).getByRole('button', { name: 'Run “Tidy owners”' }))
    expect(seed()).toEqual({ op: tidy.op })
    expect(useNotificationStore.getState().notifications.map((n) => n.message)).toEqual([
      'This view has no layer named “Silver” — choose where “Tidy owners” should apply.',
    ])
  })

  it('renames one in place', async () => {
    const user = userEvent.setup()
    render(<RecipesPanel viewId="v1" />)
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
    render(<RecipesPanel viewId="v1" />)
    await user.click(within(row('Own them')).getByRole('button', { name: 'Delete' }))
    expect(api.remove).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Delete recipe' }))
    expect(api.remove).toHaveBeenCalledWith('v1', 'r2')
    expect(screen.queryByText('Own them')).not.toBeInTheDocument()
  })

  it('leaves renaming and deleting to people who can edit the library', () => {
    useViewLibraryStore.setState({ canEdit: false })
    render(<RecipesPanel viewId="v1" />)
    expect(within(row('Own them')).getByRole('button', { name: 'Run “Own them”' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('says why a recipe can’t run yet', async () => {
    const user = userEvent.setup()
    editing.blocked = 'Switch to a draft to make changes'
    render(<RecipesPanel viewId="v1" />)
    const run = within(row('Own them')).getByRole('button', { name: 'Run “Own them”' })
    expect(run).toBeDisabled()
    await user.hover(run.parentElement!)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Switch to a draft to make changes')
  })

  it('shows nothing where no change can be made and the view keeps no recipe', () => {
    editing.offered = false
    useViewLibraryStore.setState({ bulkRecipes: [] })
    const { container } = render(<RecipesPanel viewId="v1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('runs a recipe from another view, said to be over another data source', async () => {
    const user = userEvent.setup()
    api.others.mockResolvedValueOnce([{ viewId: 'v9', viewName: 'Finance', sameSource: false, recipe: own }])
    useViewLibraryStore.setState({ bulkRecipes: [] })
    render(<RecipesPanel viewId="v1" />)
    await user.click(screen.getByRole('button', { name: 'Recipes from other views' }))
    const group = await screen.findByRole('region', { name: 'Recipes from Finance' })
    expect(api.others).toHaveBeenCalledWith('v1', expect.any(AbortSignal))
    expect(within(group).getByText(/Another data source/)).toBeInTheDocument()
    await user.click(within(group).getByRole('button', { name: 'Run “Own them”' }))
    expect(seed()).toEqual({ op: own.op, target: { kind: 'hasKey', key: 'owner' }, scopeMode: 'data_source' })
  })

  it('says when the other views couldn’t be read, and tries again', async () => {
    const user = userEvent.setup()
    api.others.mockRejectedValueOnce(new Error('Service Unavailable'))
    render(<RecipesPanel viewId="v1" />)
    await user.click(screen.getByRole('button', { name: 'From other views' }))
    expect(await screen.findByText('Couldn’t look through the other views')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('No recipes on other views yet')).toBeInTheDocument()
    expect(api.others).toHaveBeenCalledTimes(2)
  })
})
