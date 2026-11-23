/**
 * The editor's header follows the layer's own access: a Playground maker's own layer offers Save,
 * Publish, New version, Clone, Import, Export and Delete with every semantic-layer switch off and
 * no ontology:manage; a reader without manage is offered none of the writes. On their own layer
 * the maker sees whether it is theirs alone or shared, shares it with the Playground, and — on a
 * published version — moves their graphs still on an older version to it.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayerAccess, OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { WorkspaceResponse } from '@/services/workspaceService'

const { listVersions, shareLayer, updateDataSource, notify, loadWorkspaces } = vi.hoisted(() => ({
  listVersions: vi.fn(), shareLayer: vi.fn(), updateDataSource: vi.fn(), notify: vi.fn(), loadWorkspaces: vi.fn(),
}))
vi.mock('@/services/ontologyDefinitionService', () => ({ ontologyDefinitionService: { listVersions } }))
vi.mock('@/services/playgroundService', () => ({ playgroundService: { shareLayer } }))
vi.mock('@/services/workspaceService', () => ({ workspaceService: { updateDataSource } }))
vi.mock('@/hooks/usePlayground', () => ({ usePlayground: () => ({ data: { workspaceId: 'ws_play' } }) }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))

import { OntologyDetailHeader } from './OntologyDetailHeader'
import { useSemanticLayerAccess } from '../lib/useSemanticLayerAccess'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { useAuthStore } from '@/store/auth'
import { useWorkspacesStore } from '@/store/workspaces'

const OWN: LayerAccess = { canEdit: true, canPublish: true, canDelete: true, canClone: true, canShare: true, canAssign: true, isOwn: true }
const READER: LayerAccess = { canEdit: false, canPublish: false, canDelete: false, canClone: false, canShare: false, canAssign: false, isOwn: false }

const layer = (over: Partial<OntologyDefinitionResponse> = {}) => ({
  id: 'own_v1', schemaId: 'own', name: 'My things', description: null, version: 1, revision: 0, evolutionPolicy: 'reject',
  isPublished: false, isSystem: false, scope: 'workspace', deletedAt: null, createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z', containmentEdgeTypes: [], lineageEdgeTypes: [], edgeTypeMetadata: {},
  entityTypeHierarchy: {}, rootEntityTypes: [], entityTypeDefinitions: {}, relationshipTypeDefinitions: {},
  ownerWorkspaceId: 'ws_play', ownerVisibility: 'private', access: OWN, ...over,
}) as unknown as OntologyDefinitionResponse

const playground = (dataSources: unknown[]) => [{ id: 'ws_play', name: 'Playground', dataSources }] as unknown as WorkspaceResponse[]

function Header({ ontology, workspaces, pending }: { ontology: OntologyDefinitionResponse; workspaces: WorkspaceResponse[]; pending: boolean }) {
  const access = useSemanticLayerAccess(ontology)
  const isImmutable = ontology.isSystem || ontology.isPublished || !!ontology.deletedAt
  const noop = () => {}
  return (
    <OntologyDetailHeader
      ontology={ontology} isImmutable={isImmutable} access={access} hasPendingChanges={pending} isSaving={false}
      workspaces={workspaces} onDiscard={noop} onSave={noop} onReviewChanges={noop} onValidate={noop} onPublish={noop}
      onClone={noop} onCreateNewVersion={noop} onExport={noop} onImport={noop} onEditDetails={noop} onDelete={noop}
    />
  )
}

function renderHeader(ontology: OntologyDefinitionResponse, { workspaces = playground([]), pending = false } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><Header ontology={ontology} workspaces={workspaces} pending={pending} /></MemoryRouter>
    </QueryClientProvider>,
  )
}

/** The overflow menu's items, once opened. */
async function menuItems() {
  const trigger = document.querySelector<HTMLElement>('[aria-haspopup="menu"]')!
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  return (await screen.findByRole('menu')).textContent ?? ''
}

beforeEach(() => {
  vi.clearAllMocks()
  // Every semantic-layer switch off, and no ontology:manage.
  useFeaturesStore.setState({ values: {
    ...DEFAULT_FEATURES, semanticLayerEditMode: false, semanticLayerNonAdminEditing: false, semanticLayerImportEnabled: false,
    semanticLayerExportEnabled: false, semanticLayerVersionHistory: false, semanticLayerAutoSuggest: false,
  } })
  useAuthStore.setState({ user: { id: 'usr_me' } as never })
  useWorkspacesStore.setState({ loadWorkspaces })
  listVersions.mockResolvedValue([])
})

describe('OntologyDetailHeader, by the layer’s access', () => {
  it('offers a maker every write on their own draft, with the org switches off', async () => {
    renderHeader(layer(), { pending: true })
    expect(screen.getByRole('button', { name: /Save All/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument()
    const items = await menuItems()
    for (const item of ['Edit Details', 'Clone (Independent Copy)', 'Export JSON', 'Import JSON', 'Delete']) {
      expect(items).toContain(item)
    }
  })

  it('offers a new version of their own published layer', () => {
    renderHeader(layer({ isPublished: true }))
    expect(screen.getByRole('button', { name: 'New Version' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
  })

  it('offers no write at all to a reader without manage', async () => {
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, semanticLayerEditMode: true, semanticLayerNonAdminEditing: true,
      semanticLayerImportEnabled: true, semanticLayerExportEnabled: true } })
    renderHeader(layer({ access: READER, ownerVisibility: 'workspace' }), { pending: true })
    for (const name of [/Save All/, 'Discard', 'Publish', 'New Version']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    // Not theirs: no badge, no sharing.
    expect(screen.queryByText('Shared')).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    const items = await menuItems()
    for (const item of ['Edit Details', 'Clone', 'Import JSON', 'Delete']) expect(items).not.toContain(item)
    expect(items).toContain('Export JSON')
  })

  it('keeps a delete off a layer graphs use, when the server says so', async () => {
    renderHeader(layer({ access: { ...OWN, canDelete: false } }))
    expect(await menuItems()).not.toContain('Delete')
  })
})

describe('OntologyDetailHeader, the maker’s own layer', () => {
  it('says it is theirs alone, and shares it with the Playground', async () => {
    shareLayer.mockResolvedValue(layer({ ownerVisibility: 'workspace' }))
    renderHeader(layer())
    expect(screen.getByText('Yours')).toBeInTheDocument()
    const toggle = screen.getByRole('switch', { name: 'Share with the Playground' })
    expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    expect(shareLayer).toHaveBeenCalledWith('own_v1', true)
    await waitFor(() => expect(notify).toHaveBeenCalledWith('success', expect.stringContaining('Shared with the Playground')))
  })

  it('says when it is shared, and stops sharing', async () => {
    shareLayer.mockResolvedValue(layer())
    renderHeader(layer({ ownerVisibility: 'workspace', isPublished: true }))
    expect(screen.getByText('Shared')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('switch', { name: 'Share with the Playground' }))
    expect(shareLayer).toHaveBeenCalledWith('own_v1', false)
    await waitFor(() => expect(notify).toHaveBeenCalledWith('success', expect.stringContaining('keep working')))
  })

  it('says why sharing was refused', async () => {
    shareLayer.mockRejectedValue(Object.assign(new Error('nope'), { detail: { type: 'layer_not_yours' } }))
    renderHeader(layer())
    await userEvent.click(screen.getByRole('switch', { name: 'Share with the Playground' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('Only the person who made this data model can change it')))
  })

  it('moves the maker’s graphs on an older version to a published one', async () => {
    const v2 = layer({ id: 'own_v2', version: 2, isPublished: true })
    listVersions.mockResolvedValue([v2, layer()])
    updateDataSource.mockResolvedValue({})
    renderHeader(v2, { workspaces: playground([
      { id: 'ds_old', ontologyId: 'own_v1', createdBy: 'usr_me' },
      { id: 'ds_new', ontologyId: 'own_v2', createdBy: 'usr_me' },
      { id: 'ds_theirs', ontologyId: 'own_v1', createdBy: 'usr_other' },
    ]) })
    expect(await screen.findByText('1 graph of yours uses an older version.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Move my graphs to this version' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('success', '1 graph moved to v2'))
    expect(updateDataSource).toHaveBeenCalledTimes(1)
    expect(updateDataSource).toHaveBeenCalledWith('ws_play', 'ds_old', { ontologyId: 'own_v2' })
    expect(loadWorkspaces).toHaveBeenCalled()
  })

  it('offers no move from a draft, or when every graph is already on it', async () => {
    const draft = layer({ id: 'own_v2', version: 2 })
    listVersions.mockResolvedValue([draft, layer({ isPublished: true })])
    const { unmount } = renderHeader(draft, { workspaces: playground([{ id: 'ds_old', ontologyId: 'own_v1', createdBy: 'usr_me' }]) })
    await waitFor(() => expect(listVersions).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Move my graphs to this version' })).toBeNull()
    unmount()

    const v2 = layer({ id: 'own_v2', version: 2, isPublished: true })
    listVersions.mockResolvedValue([v2, layer()])
    renderHeader(v2, { workspaces: playground([{ id: 'ds_new', ontologyId: 'own_v2', createdBy: 'usr_me' }]) })
    await waitFor(() => expect(listVersions).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('button', { name: 'Move my graphs to this version' })).toBeNull()
    expect(within(document.body).getByText('Yours')).toBeInTheDocument()
  })
})

describe('OntologyDetailHeader, an org layer someone else looks after', () => {
  const before = useAuthStore.getState().permissions
  afterEach(() => useAuthStore.setState({ permissions: before }))

  it('says it is view only and why, and why Clone is switched off', async () => {
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, semanticLayerNonAdminEditing: true } })
    // Looks after layers in one workspace, may not start one; the server says this layer isn't theirs.
    useAuthStore.setState({ permissions: { sid: 't', global: [], ws: { ws_a: ['workspace:ontology:manage', 'workspace:ontology:read'] } } } as never)
    renderHeader(layer({ access: { ...READER, canAssign: true }, ownerWorkspaceId: null, ownerVisibility: null }))
    expect(screen.getByText('View only')).toBeInTheDocument()
    const items = await menuItems()
    expect(items).toContain('Clone (Independent Copy)')
    expect(items).toContain('can’t start new ones')
    expect(screen.getByRole('menuitem', { name: /Clone/ })).toHaveAttribute('data-disabled')
  })
})
