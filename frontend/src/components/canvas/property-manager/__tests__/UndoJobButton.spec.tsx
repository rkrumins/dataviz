/**
 * UndoJobButton — Undo on an ended bulk change that wrote to the draft and is still only there,
 * confirmed with how many it puts back; the undo then followed as another change. Undone once one
 * has finished; each refusal said in plain words, with what to do.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ undo: vi.fn() }))
vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()),
  undoPropertyJob: api.undo,
}))

import { useNotificationStore } from '@/components/ui/notifications'
import {
  JobActiveError, PropertyJobUndoRefusedError, type PropertyJob, type PropertyJobSummary,
} from '@/services/versioningApiService'
import { usePropertyJobsStore, type TrackedJob } from '@/store/propertyJobsStore'
import { UndoJobButton } from '../UndoJobButton'

const RENAME = { kind: 'rename' as const, key: 'owner', to: 'steward', onConflict: 'skip' as const }

function tracked(status: PropertyJob['status'], summary: Partial<PropertyJobSummary> = {}, over: Partial<TrackedJob> = {}): TrackedJob {
  return {
    jobId: 'vjob_1', wsId: 'ws1', graphId: 'g1', branchId: 'd1', viewId: 'v1', op: RENAME,
    targetLabel: 'every entity with owner', startedAt: '2026-11-21T10:00:00Z',
    job: { jobId: 'vjob_1', status, summary: { changed: 5, commits: 2, ...summary } },
    ...over,
  }
}

const undoOf = (status: PropertyJob['status'], summary: Partial<PropertyJobSummary> = {}): TrackedJob => tracked(status, summary, {
  jobId: 'vjob_2', op: { kind: 'undo', key: 'owner', to: 'steward', sourceJobId: 'vjob_1', sourceLabel: 'Rename owner → steward' },
})

const messages = () => useNotificationStore.getState().notifications.map((n) => n.message)
const dialog = () => screen.getByText('Undo “Rename owner → steward”?').closest('div.pointer-events-auto') as HTMLElement

beforeEach(() => {
  api.undo.mockReset()
  usePropertyJobsStore.setState({ jobs: [] })
  useNotificationStore.setState({ notifications: [] })
})

describe('UndoJobButton', () => {
  it('is offered on a change that ended having written to the draft — finished, stopped or failed', () => {
    for (const status of ['completed', 'cancelled', 'failed'] as const) {
      const { unmount } = render(<UndoJobButton tracked={tracked(status)} />)
      expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
      unmount()
    }
  })

  it('is not offered while it runs, once published in whole or in part, or for a change that wrote nothing', () => {
    for (const t of [tracked('running'), tracked('completed', { publishedCommitId: 'c9' }),
      tracked('completed', { landedCommitIds: ['c8'] }), tracked('completed', { commits: 0, changed: 0 })]) {
      const { container, unmount } = render(<UndoJobButton tracked={t} />)
      expect(container).toBeEmptyDOMElement()
      unmount()
    }
  })

  it('says Undone once undone — by the server, or by an undo this browser followed to the end', () => {
    const { unmount } = render(<UndoJobButton tracked={tracked('completed', { undoneBy: 'vjob_2' })} />)
    expect(screen.getByText('Undone')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
    unmount()

    usePropertyJobsStore.setState({ jobs: [undoOf('running')] })
    const running = render(<UndoJobButton tracked={tracked('completed')} />)
    expect(screen.getByRole('status')).toHaveTextContent('Being undone…')
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
    running.unmount()
    usePropertyJobsStore.setState({ jobs: [undoOf('completed')] })
    const done = render(<UndoJobButton tracked={tracked('completed')} />)
    expect(screen.getByText('Undone')).toBeInTheDocument()
    done.unmount()

    // An undo stopped part-way leaves it to undo again; while that one runs, it isn't offered.
    usePropertyJobsStore.setState({ jobs: [undoOf('cancelled')] })
    const stopped = render(<UndoJobButton tracked={tracked('completed')} />)
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
    stopped.unmount()
    usePropertyJobsStore.setState({ jobs: [undoOf('cancelled'), { ...undoOf('running'), jobId: 'vjob_3' }] })
    render(<UndoJobButton tracked={tracked('completed')} />)
    expect(screen.getByText('Being undone…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
  })

  it('an undo is never undone itself, and says how many it left because they changed since', () => {
    const { container, unmount } = render(<UndoJobButton tracked={undoOf('completed')} />)
    expect(container).toBeEmptyDOMElement()
    unmount()
    render(<UndoJobButton tracked={undoOf('completed', { changedSince: 3 })} />)
    expect(screen.getByText(/changed again since — left as they are/)).toHaveTextContent('3 changed again since — left as they are')
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
  })

  it('confirms how many it puts back, then starts the undo and follows it', async () => {
    const user = userEvent.setup()
    const started: PropertyJob = { jobId: 'vjob_2', status: 'pending', op: undoOf('pending').op }
    api.undo.mockResolvedValue(started)
    render(<UndoJobButton tracked={tracked('cancelled')} />)
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    // Amber, not a deletion's red: an undo is a change on the draft like any other.
    expect(within(dialog()).getByRole('heading', { level: 4 })).toHaveTextContent('This will put back')
    expect(within(dialog()).getByText('entities').closest('button')).toHaveTextContent('5entities — to what they held before the change')
    expect(within(dialog()).getByRole('heading', { level: 4 }).className).toMatch(/amber/)
    expect(screen.getByText(/Any changed since are left as they are, and listed/)).toBeInTheDocument()
    await user.click(within(dialog()).getByRole('button', { name: 'Undo' }))

    expect(api.undo).toHaveBeenCalledWith('ws1', 'g1', 'vjob_1', expect.stringMatching(/^propundo/))
    const [undo] = usePropertyJobsStore.getState().jobs
    expect(undo).toMatchObject({ jobId: 'vjob_2', branchId: 'd1', viewId: 'v1', op: { kind: 'undo', sourceJobId: 'vjob_1' },
      targetLabel: 'every entity with owner', job: started })
    expect(messages()).toEqual(['Undoing “Rename owner → steward” on your draft — it’s listed under Changes on this draft.'])
    expect(screen.queryByText('Undo “Rename owner → steward”?')).not.toBeInTheDocument()
  })

  it('says why it can’t start, with what to do — and a retry is the same undo', async () => {
    const user = userEvent.setup()
    api.undo.mockRejectedValueOnce(new JobActiveError('vjob_7'))
      .mockRejectedValueOnce(new PropertyJobUndoRefusedError(409, 'job_published', 'Published.'))
    render(<UndoJobButton tracked={tracked('completed')} />)
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Undo' }))
    expect(await within(dialog()).findByText('Another change is running on this draft — wait for it to finish, then undo this one.')).toBeInTheDocument()
    await user.click(within(dialog()).getByRole('button', { name: 'Undo' }))
    expect(await within(dialog()).findByText('This change has been published — make a new change instead.')).toBeInTheDocument()
    const [first, second] = api.undo.mock.calls.map((c) => c[3])
    expect(second).toBe(first)
    expect(usePropertyJobsStore.getState().jobs).toEqual([])
  })

  it('one undone already, from elsewhere, says so and reads Undone', async () => {
    const user = userEvent.setup()
    const t = tracked('completed')
    usePropertyJobsStore.setState({ jobs: [t] })
    api.undo.mockRejectedValue(new PropertyJobUndoRefusedError(409, 'already_undone', 'Undone already.', 'vjob_5'))
    const Row = () => <UndoJobButton tracked={usePropertyJobsStore((s) => s.jobs[0])} />
    render(<Row />)
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('Undone')).toBeInTheDocument()
    expect(usePropertyJobsStore.getState().jobs[0].job?.summary?.undoneBy).toBe('vjob_5')
    expect(messages()).toEqual(['Rename owner → steward was already undone.'])
  })
})
