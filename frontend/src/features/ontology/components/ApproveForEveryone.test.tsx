/** Approve for everyone: an org editor makes a published layer a workspace owns organization-wide. */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApproveForEveryone } from './ApproveForEveryone'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'

const m = vi.hoisted(() => ({
  canPublish: true, approve: vi.fn(), invalidateAll: vi.fn(), notify: vi.fn(),
}))
vi.mock('../lib/useSemanticLayerAccess', () => ({ useSemanticLayerAccess: () => ({ canPublish: m.canPublish }) }))
vi.mock('../hooks/useOntologyMutations', () => ({ useOntologyMutations: () => ({ invalidateAll: m.invalidateAll }) }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: m.notify }) }))
vi.mock('@/services/ontologyDefinitionService', () => ({ ontologyDefinitionService: { approve: m.approve } }))

const layer = (extra: Partial<OntologyDefinitionResponse> = {}) =>
  ({ id: 'bp_1', name: 'Finance lineage', isPublished: true, deletedAt: null, ownerWorkspaceId: 'ws_fin', ...extra }) as OntologyDefinitionResponse

beforeEach(() => {
  m.canPublish = true
  m.approve.mockReset().mockResolvedValue({})
  m.invalidateAll.mockReset()
  m.notify.mockReset()
})

describe('ApproveForEveryone', () => {
  it('approves a published layer a workspace owns', async () => {
    render(<ApproveForEveryone ontology={layer()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Approve for everyone' }))
    await waitFor(() => expect(m.approve).toHaveBeenCalledWith('bp_1'))
    expect(m.invalidateAll).toHaveBeenCalled()
    expect(m.notify).toHaveBeenCalledWith('success', '“Finance lineage” is approved for everyone.')
  })

  it.each([
    ['an org layer', { ownerWorkspaceId: null }],
    ['a draft', { isPublished: false }],
    ['a deleted layer', { deletedAt: '2026-11-20T00:00:00Z' }],
  ])('offers nothing on %s', (_what, extra) => {
    render(<ApproveForEveryone ontology={layer(extra as Partial<OntologyDefinitionResponse>)} />)
    expect(screen.queryByRole('button', { name: 'Approve for everyone' })).toBeNull()
  })

  it('offers nothing to someone the org’s rules don’t let publish layers', () => {
    m.canPublish = false
    render(<ApproveForEveryone ontology={layer()} />)
    expect(screen.queryByRole('button', { name: 'Approve for everyone' })).toBeNull()
  })

  it('says why when it is refused', async () => {
    m.approve.mockRejectedValueOnce(new Error('Only a published layer a workspace owns can be approved.'))
    render(<ApproveForEveryone ontology={layer()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Approve for everyone' }))
    await waitFor(() => expect(m.notify).toHaveBeenCalledWith('error', 'Only a published layer a workspace owns can be approved.'))
  })
})
