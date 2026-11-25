/**
 * "Make this a field" for a property relationships carry: a field of the relationship types that
 * carry it, in the data source's semantic layer — prefilled from how its values are stored, saved
 * with every relationship type sent whole (the server replaces them), offered no display options,
 * never on a built-in type (a roll-up), and refused for a relationship's own envelope.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkspacesStore } from '@/store/workspaces'

const notify = vi.fn()
const ont = vi.hoisted(() => ({ get: vi.fn(), listVersions: vi.fn(), update: vi.fn() }))

vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/services/ontologyDefinitionService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/ontologyDefinitionService')>()),
  ontologyDefinitionService: ont,
}))

import { PromoteRelationshipFieldDialog } from '../PromoteFieldDialog'

const SLA = { id: 'sla', name: 'SLA', type: 'string', required: false, show_in_panel: true }
const REL_DEFS = {
  FLOWS_TO: { name: 'Feeds', is_lineage: true, fields: [SLA] },
  OWNS: { name: 'Owns', category: 'association' },
  CONTAINS: { name: 'Contains', is_containment: true, fields: [] },
  TAGGED: { name: 'Tagged', fields: [{ id: 'owner', name: 'Owner', type: 'string', required: false }] },
  AGGREGATED: { name: 'Aggregated', is_system: true },
  UNUSED: { name: 'Unused', fields: [{ id: 'x', name: 'X', type: 'string', required: true }] },
}
const layer = (over: Record<string, unknown> = {}) => ({
  id: 'ont1', schemaId: 'ont1', name: 'Finance', version: 1, isPublished: false, isSystem: false, deletedAt: null,
  entityTypeDefinitions: { Dataset: { name: 'Dataset', fields: [] } },
  relationshipTypeDefinitions: structuredClone(REL_DEFS),
  ...over,
})

/** Carried by five relationship types as they are stored — one in another case, one not declared. */
const TYPES = { flows_to: 12, OWNS: 5, AGGREGATED: 4, CONTAINS: 3, TAGGED: 2, MYSTERY: 1 }

function open(propertyKey = 'owner', types: Record<string, number> = TYPES, kinds: Record<string, number> = { Integer: 25, String: 2 }) {
  const onClose = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PromoteRelationshipFieldDialog propertyKey={propertyKey} types={types} kinds={kinds} onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { dialog: screen.getByRole('dialog', { name: new RegExp(`Make ${propertyKey} a field`) }), onClose, unmount }
}

beforeEach(() => {
  notify.mockReset()
  ont.get.mockReset().mockResolvedValue(layer())
  ont.listVersions.mockReset().mockResolvedValue([])
  ont.update.mockReset().mockImplementation(async (id: string) => ({ ...layer(), id }))
  useWorkspacesStore.setState({
    activeWorkspaceId: 'ws1', activeDataSourceId: 'ds1',
    workspaces: [{ id: 'ws1', dataSources: [{ id: 'ds1', isPrimary: true, ontologyId: 'ont1' }] }],
  } as never)
})

describe('a relationship property made a field', () => {
  it('adds it to each relationship type that carries it, sending every type whole', async () => {
    const user = userEvent.setup()
    const { dialog, onClose } = open()
    expect(await within(dialog).findByText(/a draft semantic layer, as you save it/)).toBeInTheDocument()
    expect(within(dialog).getByRole('textbox', { name: 'Field name' })).toHaveValue('Owner')
    // Stored mostly as integers: a number, and said to be stored as more than one kind.
    expect(within(dialog).getByRole('combobox', { name: 'Field type' })).toHaveValue('number')
    expect(within(dialog).getByText(/stored as more than one kind today/)).toBeInTheDocument()

    // Each type by its name, matched case-insensitively; the ones that can't take it say why.
    expect(within(dialog).getByRole('checkbox', { name: /Feeds/ })).toBeChecked()
    expect(within(dialog).getByText('FLOWS_TO')).toBeInTheDocument()
    expect(within(dialog).getByRole('checkbox', { name: /Owns/ })).toBeChecked()
    expect(within(dialog).getByRole('checkbox', { name: /Contains/ })).toBeChecked()
    expect(within(dialog).getByRole('checkbox', { name: /Tagged/ })).toBeDisabled()
    expect(within(dialog).getByText('· a field already')).toBeInTheDocument()
    expect(within(dialog).getByRole('checkbox', { name: /Aggregated/ })).toBeDisabled()
    expect(within(dialog).getByText('· built in — it takes no fields')).toBeInTheDocument()
    expect(within(dialog).getByRole('checkbox', { name: /MYSTERY/ })).toBeDisabled()
    expect(within(dialog).getByText('· not a type of this semantic layer')).toBeInTheDocument()
    // A relationship's field shows nowhere: no display options.
    expect(within(dialog).queryByRole('checkbox', { name: /Node|Panel|Tooltip/ })).toBeNull()

    // What it will do, said before it is done.
    expect(within(dialog).getByText(/Adds the field/)).toHaveTextContent('Adds the field owner to 3 relationship types')
    await user.click(within(dialog).getByRole('checkbox', { name: /^Required/ }))
    expect(within(dialog).getByText(/27 relationships hold it now/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Add the field' }))

    expect(ont.update).toHaveBeenCalledTimes(1)
    const [id, req] = ont.update.mock.calls[0]
    expect(id).toBe('ont1')
    expect(Object.keys(req)).toEqual(['relationshipTypeDefinitions'])
    const field = (order: number) => ({
      id: 'owner', name: 'Owner', type: 'number', required: true,
      show_in_node: false, show_in_panel: true, show_in_tooltip: false, display_order: order,
    })
    expect(req.relationshipTypeDefinitions).toEqual({
      FLOWS_TO: { ...REL_DEFS.FLOWS_TO, fields: [SLA, field(1)] },
      OWNS: { ...REL_DEFS.OWNS, fields: [field(0)] },
      CONTAINS: { ...REL_DEFS.CONTAINS, fields: [field(0)] },
      // Every other type, as it was.
      TAGGED: REL_DEFS.TAGGED,
      AGGREGATED: REL_DEFS.AGGREGATED,
      UNUSED: REL_DEFS.UNUSED,
    })
    expect(notify).toHaveBeenCalledWith('success', 'Owner is a field of Feeds, Owns, Contains relationships in “Finance”.', expect.anything())
    expect(onClose).toHaveBeenCalled()
  })

  it('leaves out a type unticked, and asks for one when none is left', async () => {
    const user = userEvent.setup()
    const { dialog, unmount } = open('owner', { FLOWS_TO: 3, OWNS: 1 }, { String: 4 })
    await within(dialog).findByText(/a draft semantic layer/)
    expect(within(dialog).getByRole('combobox', { name: 'Field type' })).toHaveValue('string')
    await user.click(within(dialog).getByRole('checkbox', { name: /Owns/ }))
    expect(within(dialog).getByText(/Adds the field/)).toHaveTextContent('Adds the field owner to 1 relationship type')
    await user.click(within(dialog).getByRole('button', { name: 'Add the field' }))
    const req = ont.update.mock.calls[0][1]
    expect(req.relationshipTypeDefinitions.OWNS).toEqual(REL_DEFS.OWNS)
    expect(req.relationshipTypeDefinitions.FLOWS_TO.fields).toHaveLength(2)

    unmount()
    const again = open('owner', { FLOWS_TO: 3 }, { String: 3 }).dialog
    await within(again).findByText(/a draft semantic layer/)
    await user.click(within(again).getByRole('checkbox', { name: /Feeds/ }))
    expect(within(again).getByText('Pick a type to add it to')).toBeInTheDocument()
    expect(within(again).getByRole('button', { name: 'Add the field' })).toBeDisabled()
  })

  it('says so when no type it is on can take it — a roll-up, or a field already', async () => {
    const { dialog } = open('owner', { AGGREGATED: 9, TAGGED: 2 })
    expect(await within(dialog).findByText('None of the relationship types it is on can take it')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Add the field' })).toBeDisabled()
  })

  it.each(['id', 'confidence', 'properties', 'gvHash'])('refuses %s: part of every relationship, not a property it carries', async (key) => {
    const { dialog } = open(key, { FLOWS_TO: 3 })
    expect(within(dialog).getByRole('alert')).toHaveTextContent(`${key} can’t be a field`)
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/not a property relationships carry/)
    expect(within(dialog).queryByRole('textbox', { name: 'Field name' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: /Add the field|Save as a new version/ })).toBeNull()
    expect(ont.update).not.toHaveBeenCalled()
  })

  it('a published layer changes by a new version, as an entity field does', async () => {
    const user = userEvent.setup()
    ont.get.mockResolvedValue(layer({ isPublished: true }))
    const { dialog } = open('owner', { FLOWS_TO: 3 }, { String: 3 })
    expect(await within(dialog).findByText(/Saving makes a new draft version with this field/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Save as a new version' }))
    expect(notify.mock.calls[0][1]).toMatch(/^Owner is a field of Feeds relationships in v1 of “Finance”, a draft/)
  })
})
