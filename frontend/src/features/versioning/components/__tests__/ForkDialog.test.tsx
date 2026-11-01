/**
 * ForkDialog — a manager forks a data source's graph with a name; the dialog closes once the fork is
 * made (the Forks list reads the new one). A refusal — the fork cap, paused editing, forks turned
 * off — is said in the server's words in the dialog, which stays open.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mutateAsync = vi.fn()
const notify = vi.fn()

vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('../../hooks/useVersioning', () => ({
  useCreateFork: (...args: unknown[]) => ({ mutateAsync: (v: unknown) => mutateAsync(args, v), isPending: false }),
}))

import { ForkDialog } from '../ForkDialog'
import { ForkRefusedError } from '@/services/versioningApiService'

const onClose = vi.fn()
const renderDialog = () => render(<ForkDialog wsId="ws1" graphId="g1" open onClose={onClose} />)

beforeEach(() => {
  mutateAsync.mockReset().mockResolvedValue({ graphId: 'g_f', dataSourceId: 'dsfork_1' })
  notify.mockReset()
  onClose.mockReset()
})

describe('ForkDialog', () => {
  it('forks the graph with the name given, then closes', async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Q3 restructure' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create fork' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(mutateAsync).toHaveBeenCalledWith(['ws1', 'g1'], { name: 'Q3 restructure' })
    expect(notify).toHaveBeenCalledWith('success', expect.stringMatching(/fork/i))
  })

  it('says why the fork was refused, and stays open', async () => {
    mutateAsync.mockRejectedValue(new ForkRefusedError({ type: 'fork_limit', limit: 10 }))
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Create fork' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This graph already has 10 forks. Delete one first.')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps the focus in the name field while it is typed in', () => {
    renderDialog()
    const input = screen.getByLabelText('Name')
    input.focus()
    fireEvent.change(input, { target: { value: 'Q' } })
    fireEvent.change(input, { target: { value: 'Q3' } })
    expect(document.activeElement).toBe(input)
  })

  it('renders nothing while closed', () => {
    render(<ForkDialog wsId="ws1" graphId="g1" open={false} onClose={onClose} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
