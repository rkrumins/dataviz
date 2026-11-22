/**
 * "Make it a field…" — a property promoted to a field of the entity types that carry it, in the
 * data source's semantic layer: offered to who may edit the layer, prefilled from the catalog (its
 * key, a type from how it is stored, the values it holds, the types it is on), and saved where the
 * layer's lifecycle puts it — in place in a draft, in a newer draft version of a published one (or
 * a new version made for it), never in the built-in layer, which says what to do instead.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PropertyCatalogState } from '@/hooks/usePropertyCatalog'
import type { EntityEditing } from '@/features/versioning/hooks/useEntityEditing'
import type { SearchCatalogProperty } from '@/types/search'
import { useWorkspacesStore } from '@/store/workspaces'

const notify = vi.fn()
const ont = vi.hoisted(() => ({ get: vi.fn(), listVersions: vi.fn(), update: vi.fn() }))
let state: PropertyCatalogState
let canEditLayer = true
const editing: EntityEditing = { offered: true, blocked: null } as EntityEditing

vi.mock('@/hooks/usePropertyCatalog', () => ({ usePropertyCatalog: () => state }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/features/versioning/hooks/useEntityEditing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/versioning/hooks/useEntityEditing')>()),
  useEntityEditing: () => editing,
}))
vi.mock('@/features/ontology/lib/useSemanticLayerAccess', () => ({
  useSemanticLayerAccess: () => ({ canEdit: canEditLayer }),
}))
vi.mock('@/services/ontologyDefinitionService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/ontologyDefinitionService')>()),
  ontologyDefinitionService: ont,
}))

import { PropertyBrowser } from '../PropertyBrowser'

const OWNER: SearchCatalogProperty = {
  key: 'owner', count: 900, byEntityType: { dataset: 600, Column: 300 }, kinds: { String: 900 },
  distinct: 2, distinctExact: true, residual: 0,
  values: [{ value: 'ann', kind: 'String', count: 700 }, { value: 'bob', kind: 'String', count: 200 }],
}

const layer = (over: Record<string, unknown> = {}) => ({
  id: 'ont1', schemaId: 'ont1', name: 'Finance', version: 1, isPublished: false, isSystem: false, deletedAt: null,
  entityTypeDefinitions: { Dataset: { name: 'Dataset', fields: [{ id: 'name', name: 'Name', type: 'string', required: true }] } },
  ...over,
})

function renderBrowser() {
  state = {
    catalog: {
      sessionId: 's', status: 'complete', stale: false, entities: 1000, asOf: new Date().toISOString(),
      entityTypes: [{ type: 'dataset', count: 700 }], properties: [OWNER], tags: [],
    },
    reading: null, error: null, unavailable: false, refresh: vi.fn(),
  } as PropertyCatalogState
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PropertyBrowser viewId="view-1" onCreateRuleFromPredicate={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'More actions for owner' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Make it a field…' }))
  return screen.getByRole('dialog', { name: /Make owner a field/ })
}

beforeEach(() => {
  notify.mockReset()
  canEditLayer = true
  ont.get.mockReset().mockResolvedValue(layer())
  ont.listVersions.mockReset().mockResolvedValue([])
  ont.update.mockReset().mockImplementation(async (id: string) => ({ ...layer(), id, version: id === 'ont1' ? 1 : 2 }))
  useWorkspacesStore.setState({
    activeWorkspaceId: 'ws1', activeDataSourceId: 'ds1',
    workspaces: [{ id: 'ws1', dataSources: [{ id: 'ds1', isPrimary: true, ontologyId: 'ont1' }] }],
  } as never)
})

describe('Make it a field…', () => {
  it('is offered only to who may edit the semantic layer', async () => {
    canEditLayer = false
    renderBrowser()
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions for owner' }))
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Make it a field…' })).toBeNull()
  })

  it('adds the field, prefilled from the catalog, to a draft layer in place', async () => {
    const user = userEvent.setup()
    renderBrowser()
    const dialog = await openDialog(user)
    expect(await within(dialog).findByText(/a draft semantic layer, as you save it/)).toBeInTheDocument()
    expect(within(dialog).getByRole('textbox', { name: 'Field name' })).toHaveValue('Owner')
    expect(within(dialog).getByRole('combobox', { name: 'Field type' })).toHaveValue('string')
    // The types it is on, as the layer declares them — one it doesn't is said, and left out.
    expect(within(dialog).getByRole('checkbox', { name: /Dataset/ })).toBeChecked()
    expect(within(dialog).getByText('· not a type of this semantic layer')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Allow just the 2 values it holds' }))
    await user.click(within(dialog).getByRole('checkbox', { name: /^Required/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Add the field' }))

    expect(ont.update).toHaveBeenCalledTimes(1)
    const [id, req] = ont.update.mock.calls[0]
    expect(id).toBe('ont1')
    expect(req.entityTypeDefinitions.Dataset.fields).toEqual([
      { id: 'name', name: 'Name', type: 'string', required: true },
      { id: 'owner', name: 'Owner', type: 'string', required: true, show_in_node: false, show_in_panel: true,
        show_in_tooltip: false, display_order: 1, allowed_values: ['ann', 'bob'] },
    ])
    expect(notify).toHaveBeenCalledWith('success', 'Owner is a field of Dataset in “Finance”.', expect.anything())
  })

  it('a published layer changes by a new version: a newer draft takes it, or one is made for it', async () => {
    const user = userEvent.setup()
    ont.get.mockResolvedValue(layer({ isPublished: true }))
    renderBrowser()
    let dialog = await openDialog(user)
    expect(await within(dialog).findByText(/Saving makes a new draft version with this field/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Save as a new version' }))
    expect(ont.update.mock.calls[0][0]).toBe('ont1')
    expect(notify.mock.calls[0][1]).toMatch(/in v1 of “Finance”, a draft — publish it and assign it to this data source/)

    ont.listVersions.mockResolvedValue([layer({ isPublished: true }), layer({ id: 'ont2', version: 2 })])
    dialog = await openDialog(user)
    expect(await within(dialog).findByText(/adds the field to v2, the draft already started/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Add the field' }))
    expect(ont.update.mock.calls[1][0]).toBe('ont2')
  })

  it('the built-in layer is not changed: it says to clone it, with the way there', async () => {
    const user = userEvent.setup()
    ont.get.mockResolvedValue(layer({ isSystem: true, isPublished: true }))
    renderBrowser()
    const dialog = await openDialog(user)
    expect(await within(dialog).findByText(/the built-in semantic layer/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /Add the field|Save as a new version/ })).toBeNull()
    expect(within(dialog).getByRole('button', { name: /Open the semantic layer/ })).toBeInTheDocument()
  })
})
