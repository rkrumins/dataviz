/**
 * ProposeToParentButton — a fork's changes proposed to its parent as a review, with a title, a
 * description and reviewers, as sending a draft for review asks. Behind its parent, it says to
 * update from parent first: its review merges only once the fork has taken those changes. The new
 * review — or the one the fork already has — opens in the reviews inbox.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mutateAsync = vi.fn()
const notify = vi.fn()

vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('../../hooks/useVersioning', () => ({
  useOpenForkPullRequest: (...args: unknown[]) => ({ mutateAsync: (v: unknown) => mutateAsync(args, v), isPending: false }),
}))
vi.mock('../ReviewerPicker', () => ({
  ReviewerPicker: ({ dataSourceId, onChange }: { dataSourceId?: string; onChange: (ids: string[]) => void }) =>
    <button type="button" data-source={dataSourceId} onClick={() => onChange(['u2'])}>Pick Bo</button>,
}))

import { ProposeToParentButton } from '../ProposeToParentButton'
import { PullRequestExistsError } from '@/services/versioningApiService'

function Where() {
  const loc = useLocation()
  return <span data-testid="where">{loc.pathname}{loc.search}</span>
}

const renderButton = (behind: number) => render(
  <MemoryRouter initialEntries={['/here']}>
    <Routes>
      <Route path="/here" element={<ProposeToParentButton wsId="ws1" forkGraphId="g_f" parentDataSourceId="ds1" behind={behind} />} />
      <Route path="/workspaces/:wsId/reviews" element={<Where />} />
    </Routes>
  </MemoryRouter>,
)

beforeEach(() => {
  mutateAsync.mockReset().mockResolvedValue({ prId: 'pr_9' })
  notify.mockReset()
})

describe('ProposeToParentButton', () => {
  it('says to update from parent first while the fork is behind its parent', () => {
    renderButton(3)
    expect(screen.getByText('Update from parent first')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Propose to parent' })).toBeEnabled()
  })

  it('says nothing of the kind once the fork is up to date', () => {
    renderButton(0)
    expect(screen.queryByText('Update from parent first')).toBeNull()
  })

  it('opens a review with a title, a description and reviewers, and goes to it', async () => {
    renderButton(0)
    fireEvent.click(screen.getByRole('button', { name: 'Propose to parent' }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Q3 restructure' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Moves the marts' } })
    expect(screen.getByRole('button', { name: 'Pick Bo' })).toHaveAttribute('data-source', 'ds1')
    fireEvent.click(screen.getByRole('button', { name: 'Pick Bo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open review' }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/workspaces/ws1/reviews?pr=pr_9'))
    expect(mutateAsync).toHaveBeenCalledWith(['ws1', 'g_f'],
      { title: 'Q3 restructure', description: 'Moves the marts', reviewers: ['u2'] })
    expect(notify).toHaveBeenCalledWith('success', 'Sent for review.')
  })

  it('goes to the review the fork already has', async () => {
    mutateAsync.mockRejectedValue(new PullRequestExistsError({ prId: 'pr_old' }))
    renderButton(0)
    fireEvent.click(screen.getByRole('button', { name: 'Propose to parent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open review' }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/workspaces/ws1/reviews?pr=pr_old'))
  })

  it('keeps the focus in the field it is in when the row around it renders again', () => {
    const { rerender } = renderButton(0)
    fireEvent.click(screen.getByRole('button', { name: 'Propose to parent' }))
    const title = screen.getByLabelText('Title')
    title.focus()
    rerender(
      <MemoryRouter initialEntries={['/here']}>
        <Routes>
          <Route path="/here" element={<ProposeToParentButton wsId="ws1" forkGraphId="g_f" parentDataSourceId="ds1" behind={1} />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(document.activeElement).toBe(screen.getByLabelText('Title'))
  })

  it('says why opening a review was refused, and stays open', async () => {
    mutateAsync.mockRejectedValue(new Error('Forks are turned off for this deployment.'))
    renderButton(0)
    fireEvent.click(screen.getByRole('button', { name: 'Propose to parent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open review' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Forks are turned off for this deployment.')
  })
})
