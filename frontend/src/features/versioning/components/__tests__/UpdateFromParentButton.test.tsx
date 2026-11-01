/**
 * UpdateFromParentButton — a fork takes its parent's changes:
 *   • an update that ran says what it did, or that the fork was up to date already;
 *   • a large update runs as a job, and the button says it is updating until the job ends, as a
 *     publish's button does;
 *   • what both changed opens the pull's conflict resolver, seeded with the fork's own values the
 *     refusal hands back, and the resolutions go back with the next update.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let resolverProps: { conflicts?: unknown; seeds?: unknown; error?: unknown; onResolve?: (r: unknown) => void } | null
const notify = vi.fn()
const mutate = vi.fn()
let isPending = false

vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/features/reviews/components/ConflictResolver', () => ({
  ConflictResolver: (props: NonNullable<typeof resolverProps>) => {
    resolverProps = props
    return <div>resolving</div>
  },
}))
vi.mock('../../hooks/useVersioning', () => ({
  useUpdateFromParent: (...args: unknown[]) => ({ isPending, mutate: (v: unknown, cb: unknown) => mutate(args, v, cb) }),
}))

import { UpdateFromParentButton } from '../UpdateFromParentButton'
import { ForkUpdateConflictsError } from '@/services/versioningApiService'

type Callbacks = { onSuccess: (res: unknown) => void; onError: (e: unknown) => void }
const answerWith = (fn: (cb: Callbacks) => void) =>
  mutate.mockImplementation((_args: unknown, _v: unknown, cb: Callbacks) => fn(cb))

const conflicts = [{ entity_id: 'n1', path: ['displayName'], base: 'A', ours: 'B', theirs: 'C' }]

beforeEach(() => {
  resolverProps = null
  notify.mockReset()
  mutate.mockReset()
  isPending = false
})

describe('UpdateFromParentButton', () => {
  it('updates the fork, and says what it took in', () => {
    answerWith(({ onSuccess }) => onSuccess({ commitId: 'c9', parentSeq: 12, wrote: 3, upToDate: false }))
    render(<UpdateFromParentButton wsId="ws1" forkGraphId="g_f" />)
    fireEvent.click(screen.getByRole('button', { name: 'Update from parent' }))
    expect(mutate).toHaveBeenCalledWith(['ws1', 'g_f'], { resolutions: undefined }, expect.anything())
    expect(notify).toHaveBeenCalledWith('success', 'Updated from its parent: 3 changes merged.')
  })

  it('says when the fork was up to date already', () => {
    answerWith(({ onSuccess }) => onSuccess({ commitId: null, parentSeq: 12, wrote: 0, upToDate: true }))
    render(<UpdateFromParentButton wsId="ws1" forkGraphId="g_f" />)
    fireEvent.click(screen.getByRole('button', { name: 'Update from parent' }))
    expect(notify).toHaveBeenCalledWith('info', 'Already up to date with its parent.')
  })

  it('says it is updating while the update — or its job — runs', () => {
    isPending = true
    render(<UpdateFromParentButton wsId="ws1" forkGraphId="g_f" />)
    const button = screen.getByRole('button', { name: 'Updating…' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })

  it('opens the conflict resolver on what both changed, and sends the resolutions back', () => {
    answerWith(({ onError }) => onError(new ForkUpdateConflictsError({ conflicts, seeds: { n1: { displayName: 'B' } } })))
    render(<UpdateFromParentButton wsId="ws1" forkGraphId="g_f" />)
    fireEvent.click(screen.getByRole('button', { name: 'Update from parent' }))
    expect(screen.getByText('resolving')).toBeInTheDocument()
    expect(resolverProps?.conflicts).toEqual(conflicts)
    expect(resolverProps?.seeds).toEqual({ n1: { displayName: 'B' } })

    answerWith(({ onSuccess }) => onSuccess({ commitId: 'c10', parentSeq: 12, wrote: 1, upToDate: false }))
    resolverProps?.onResolve?.({ n1: { displayName: 'C' } })
    expect(mutate).toHaveBeenLastCalledWith(['ws1', 'g_f'], { resolutions: { n1: { displayName: 'C' } } }, expect.anything())
  })

  it('says when only the first of many conflicts are shown', () => {
    answerWith(({ onError }) => onError(new ForkUpdateConflictsError({ conflicts, seeds: {}, total: 140 })))
    render(<UpdateFromParentButton wsId="ws1" forkGraphId="g_f" />)
    fireEvent.click(screen.getByRole('button', { name: 'Update from parent' }))
    expect(resolverProps?.error).toMatch(/first 1 of 140/)
  })

  it('says why an update was refused', () => {
    answerWith(({ onError }) => onError(new Error('Forks are turned off for this deployment.')))
    render(<UpdateFromParentButton wsId="ws1" forkGraphId="g_f" />)
    fireEvent.click(screen.getByRole('button', { name: 'Update from parent' }))
    expect(notify).toHaveBeenCalledWith('error', 'Forks are turned off for this deployment.')
  })
})
