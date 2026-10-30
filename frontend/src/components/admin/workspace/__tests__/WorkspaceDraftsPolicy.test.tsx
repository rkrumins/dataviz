/**
 * WorkspaceDraftsPolicy — the workspace's drafts and reviews policy:
 *   • each setting shows the workspace's own value, or "Default" with the built-in value named;
 *   • a workspace admin changes settings and saves only the ones changed, "Default" sent as 'inherit';
 *   • a level that is the only one allowed is where new drafts start, and the card says so;
 *   • everyone else reads it, and can't change it.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DraftsPolicySettings, WorkspaceDraftsPolicy as Policy } from '@/services/versioningApiService'

const notify = vi.fn()
const put = vi.fn()
let policy: Policy | undefined

vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
  useWorkspaceDraftsPolicy: () => ({ data: policy }),
  useSetWorkspaceDraftsPolicy: () => ({ mutateAsync: put, isPending: false }),
}))

import { WorkspaceDraftsPolicy } from '../WorkspaceDraftsPolicy'

const settings = (over: Partial<DraftsPolicySettings> = {}): DraftsPolicySettings =>
  ({ defaultVisibility: null, levels: null, selfApproval: null, selfMerge: null, ...over })

const LABELS = [
  'New drafts start', 'Drafts may be', 'Whoever opens a review may approve it', 'Whoever opens a review may merge it',
]

const renderCard = (canEdit = true) => {
  render(<WorkspaceDraftsPolicy wsId="ws1" canEdit={canEdit} />)
  fireEvent.click(screen.getByRole('button', { name: /Drafts and reviews/ }))
}

beforeEach(() => {
  notify.mockReset()
  put.mockReset().mockResolvedValue({})
  policy = {
    settings: settings({ defaultVisibility: 'private', selfMerge: false }),
    effective: {
      defaultVisibility: 'private', levels: 'any', selfApproval: true, selfMerge: false,
      sources: { defaultVisibility: 'workspace', levels: 'default', selfApproval: 'default', selfMerge: 'workspace' },
    },
  }
})

describe('the workspace’s drafts and reviews policy', () => {
  it('shows each setting: the workspace’s own, or the default with its value named', () => {
    renderCard()
    expect(screen.getByLabelText('New drafts start')).toHaveDisplayValue('Private')
    expect(screen.getByLabelText('Drafts may be')).toHaveDisplayValue('Default (Public or private)')
    expect(screen.getByLabelText('Whoever opens a review may approve it')).toHaveDisplayValue('Default (Yes)')
    expect(screen.getByLabelText('Whoever opens a review may merge it')).toHaveDisplayValue('No')
    expect(screen.getByText('Drafts are then published only through a review someone else merges.')).toBeInTheDocument()
    expect(screen.getByText('Turning private drafts off leaves existing private drafts as they are.')).toBeInTheDocument()
  })

  it('saves only what an admin changed, and a setting back to the default as inherit', async () => {
    renderCard()
    fireEvent.change(screen.getByLabelText('New drafts start'), { target: { value: 'inherit' } })
    fireEvent.change(screen.getByLabelText('Whoever opens a review may approve it'), { target: { value: 'false' } })
    // Changed, and changed back: nothing to send.
    fireEvent.change(screen.getByLabelText('Drafts may be'), { target: { value: 'public_only' } })
    fireEvent.change(screen.getByLabelText('Drafts may be'), { target: { value: 'inherit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).toHaveBeenCalledWith({ defaultVisibility: 'inherit', selfApproval: false }))
    expect(notify).toHaveBeenCalledWith('success', expect.any(String))
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('says new drafts start at the only level drafts may be', () => {
    renderCard()
    fireEvent.change(screen.getByLabelText('Drafts may be'), { target: { value: 'public_only' } })
    expect(screen.getByText('Drafts may only be public, so new drafts start public.')).toBeInTheDocument()
  })

  it('says why a save was refused, and keeps the change', async () => {
    put.mockRejectedValue(new Error('Only a workspace admin can change this'))
    renderCard()
    fireEvent.change(screen.getByLabelText('Drafts may be'), { target: { value: 'private_only' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('error', 'Only a workspace admin can change this'))
    expect(screen.getByLabelText('Drafts may be')).toHaveDisplayValue('Private only')
  })

  it('is read-only to someone who isn’t a workspace admin', () => {
    renderCard(false)
    for (const label of LABELS) expect(screen.getByLabelText(label)).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })
})
