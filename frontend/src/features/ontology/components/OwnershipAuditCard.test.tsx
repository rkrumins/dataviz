/**
 * Ownership & audit: who made, changed and published a layer — by name — which workspace owns it,
 * and whether the reader can change it, with the reason when they can't; a way into its history
 * only while they may read it.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayerAccess, OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { WorkspaceResponse } from '@/services/workspaceService'

vi.mock('@/services/userDirectoryService', async (orig) => ({
  ...(await orig<typeof import('@/services/userDirectoryService')>()),
  peopleById: vi.fn(async (ids: string[]) => ids.map(id => ({
    id, displayName: { usr_ada: 'Ada Okafor', usr_ben: 'Ben Ito' }[id] ?? id, email: `${id}@example.com`, deleted: false,
  }))),
}))

import { OwnershipAuditCard } from './OwnershipAuditCard'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { useAuthStore } from '@/store/auth'

const NOT_YOURS: LayerAccess = { canEdit: false, canPublish: false, canDelete: false, canClone: true, canShare: false, canAssign: true, isOwn: false }
const layer = (over: Partial<OntologyDefinitionResponse> = {}) => ({
  id: 'ont_v2', schemaId: 'ont', name: 'Finance', version: 2, isPublished: true, isSystem: false,
  createdAt: '2026-11-01T09:00:00Z', createdBy: 'usr_ada', updatedAt: '2026-11-20T15:30:00Z', updatedBy: 'usr_ben',
  publishedAt: '2026-11-21T08:00:00Z', publishedBy: 'usr_ada', deletedAt: null, deletedBy: null,
  ownerWorkspaceId: null, ownerVisibility: null, access: NOT_YOURS, ...over,
}) as unknown as OntologyDefinitionResponse

function renderCard(ontology: OntologyDefinitionResponse, onOpenHistory = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OwnershipAuditCard ontology={ontology} onOpenHistory={onOpenHistory}
          workspaces={[{ id: 'ws_lab', name: 'Research Lab' }] as unknown as WorkspaceResponse[]} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return onOpenHistory
}

const signedOut = useAuthStore.getState().permissions
beforeEach(() => {
  useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, semanticLayerNonAdminEditing: true } })
  useAuthStore.setState({ permissions: signedOut })
})

describe('OwnershipAuditCard', () => {
  it('names who made, changed and published it, and opens its history', async () => {
    // Looks after layers somewhere — just not where this one is used.
    useAuthStore.setState({ permissions: { sid: 't', global: [], ws: { ws_a: ['workspace:ontology:manage'] } } } as never)
    const open = renderCard(layer())
    expect(screen.getByRole('heading', { name: 'Ownership & audit' })).toBeInTheDocument()
    expect(await screen.findAllByText('Ada Okafor')).toHaveLength(2)    // made it, published it
    expect(screen.getByText('Ben Ito')).toBeInTheDocument()
    expect(screen.getByText('v2')).toBeInTheDocument()
    expect(screen.getByText('ont')).toBeInTheDocument()
    expect(screen.getByText('every version shares it')).toBeInTheDocument()
    expect(screen.getByText('The organisation')).toBeInTheDocument()
    // Not theirs to change, and why.
    expect(screen.getByText(/in a workspace that uses this layer can change it/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Full history/ }))
    expect(open).toHaveBeenCalledOnce()
  })

  it('names the workspace that owns it, says a draft is unpublished, and says when they can change it', () => {
    renderCard(layer({ ownerWorkspaceId: 'ws_lab', isPublished: false, publishedAt: null, publishedBy: null,
      access: { ...NOT_YOURS, canEdit: true } }))
    expect(screen.getByText('Research Lab')).toBeInTheDocument()
    expect(screen.getByText('Not yet — this version is a draft')).toBeInTheDocument()
    expect(screen.getByText('You can')).toBeInTheDocument()
  })

  it('offers no way into history while it is switched off, and says when nobody was recorded', () => {
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, semanticLayerVersionHistory: false } })
    renderCard(layer({ createdBy: null }))
    expect(screen.queryByRole('button', { name: /Full history/ })).toBeNull()
    expect(screen.getByText('· not recorded who')).toBeInTheDocument()
  })
})
