/**
 * ReviewerPicker — people who can approve and, where the caller takes them, groups (with how many
 * people are in each); a search narrows both. A fork's proposal asks people only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const api = vi.hoisted(() => ({ listReviewerCandidates: vi.fn(), listReviewerGroups: vi.fn() }))
vi.mock('@/services/versioningApiService', async (orig) => ({
  ...(await orig<typeof import('@/services/versioningApiService')>()),
  ...api,
}))

import { ReviewerPicker } from '../ReviewerPicker'

beforeEach(() => {
  api.listReviewerCandidates.mockReset().mockResolvedValue([
    { userId: 'u_carol', displayName: 'Carol Chen', email: 'carol@example.com' },
    { userId: 'u_dave', displayName: 'Dave Diaz', email: 'dave@example.com' },
  ])
  api.listReviewerGroups.mockReset().mockResolvedValue([
    { groupId: 'g_fin', name: 'Finance stewards', description: 'Own the ledgers', memberCount: 4 },
    { groupId: 'g_ops', name: 'Ops', memberCount: 1 },
  ])
})

describe('ReviewerPicker', () => {
  it('narrows people and groups by a search', async () => {
    render(<ReviewerPicker wsId="ws1" value={[]} onChange={vi.fn()} groups={[]} onGroupsChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Add reviewers/ }))
    expect(await screen.findByRole('button', { name: /Carol Chen/ })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /Finance stewards/ })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search people and groups' }), { target: { value: 'DAVE@' } })
    expect(screen.queryByRole('button', { name: /Carol Chen/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Dave Diaz/ })).toBeInTheDocument()
    expect(screen.getByText('No group matches.')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ledgers' } })
    expect(screen.getByRole('button', { name: /Finance stewards/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Ops/ })).toBeNull()
    expect(screen.getByText('No one matches.')).toBeInTheDocument()
  })

  it('asks groups, each with how many people are in it', async () => {
    const onGroupsChange = vi.fn()
    const { rerender } = render(<ReviewerPicker wsId="ws1" value={[]} onChange={vi.fn()} groups={[]} onGroupsChange={onGroupsChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Add reviewers/ }))
    const fin = await screen.findByRole('button', { name: /Finance stewards.*4 members/ })
    expect(screen.getByRole('button', { name: /Ops.*1 member/ })).toBeInTheDocument()
    fireEvent.click(fin)
    expect(onGroupsChange).toHaveBeenCalledWith(['g_fin'])
    rerender(<ReviewerPicker wsId="ws1" value={[]} onChange={vi.fn()} groups={['g_fin']} onGroupsChange={onGroupsChange} />)
    expect(screen.getByRole('button', { name: /Finance stewards.*4 members/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Remove Finance stewards' }))
    expect(onGroupsChange).toHaveBeenLastCalledWith([])
  })

  it('asks people only where the caller takes no groups', async () => {
    const onChange = vi.fn()
    render(<ReviewerPicker wsId="ws1" dataSourceId="ds1" value={[]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Add reviewers/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Carol Chen/ }))
    expect(onChange).toHaveBeenCalledWith(['u_carol'])
    expect(api.listReviewerCandidates).toHaveBeenCalledWith('ws1', 'ds1')
    expect(api.listReviewerGroups).not.toHaveBeenCalled()
    expect(screen.queryByText('Groups')).toBeNull()
    expect(screen.getByRole('searchbox', { name: 'Search people' })).toBeInTheDocument()
  })
})
