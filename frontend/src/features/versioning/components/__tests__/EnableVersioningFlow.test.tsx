/**
 * EnableVersioningFlow — what the user is told before turning version control on.
 *
 * First, what it means: above all, that changes an upstream system writes straight to the graph
 * stay out of version history until someone brings them in. Then the pre-flight: how big the
 * copy is and roughly how long it may take (a bucket, never an invented number), and that
 * duplicate identifiers are checked first, with nothing copied until they decide.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../hooks/useVersioning', () => ({
  useBootstrapGraph: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))

import { EnableVersioningFlow } from '../EnableVersioningFlow'

const open = (itemCount?: number | null) =>
  render(<EnableVersioningFlow open onClose={vi.fn()} wsId="ws1" dataSourceId="ds1" itemCount={itemCount} />)

const continueToPreflight = () => fireEvent.click(screen.getByRole('button', { name: /Continue/ }))

describe('what it means', () => {
  it('opens on the explanation, with no way to start the copy from it', () => {
    open(1_000)
    expect(screen.getByRole('heading', { name: 'Updates from upstream systems aren’t synced into history' }))
      .toBeInTheDocument()
    expect(screen.getByText('But they aren’t in version history')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Turn on version control/ })).not.toBeInTheDocument()
  })

  it('says how outside changes can be lost, and the two ways to keep them', () => {
    open(1_000)
    expect(screen.getByText('History’s copy can overwrite them')).toBeInTheDocument()
    expect(screen.getByText('Bring into history')).toBeInTheDocument()
    expect(screen.getByText('Write through this app instead')).toBeInTheDocument()
  })

  it('goes back from the pre-flight, and every new opening starts at the explanation', () => {
    const onClose = vi.fn()
    const { rerender } = render(<EnableVersioningFlow open onClose={onClose} wsId="ws1" dataSourceId="ds1" />)
    continueToPreflight()
    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect(screen.getByRole('button', { name: /Continue/ })).toBeInTheDocument()

    continueToPreflight()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
    rerender(<EnableVersioningFlow open={false} onClose={onClose} wsId="ws1" dataSourceId="ds1" />)
    rerender(<EnableVersioningFlow open onClose={onClose} wsId="ws1" dataSourceId="ds1" />)
    expect(screen.getByRole('button', { name: /Continue/ })).toBeInTheDocument()
  })
})

describe('before the copy starts', () => {
  it('promises a duplicate check first, and that nothing is copied until the user decides', () => {
    open(1_000)
    continueToPreflight()
    expect(
      screen.getByText('We check for duplicate identifiers first; nothing is copied until you decide.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Turn on version control/ })).toBeEnabled()
  })

  it.each([
    [150_000, /about 150,000 items/, /usually done in a couple of minutes/],
    [1_200_000, /about 1,200,000 items/, /usually done within half an hour/],
    [9_000_000, /about 9,000,000 items/, /can take an hour or more/],
  ])('sizes a %d-item graph and says roughly how long it takes', (count, size, duration) => {
    open(count)
    continueToPreflight()
    expect(screen.getByText(size)).toBeInTheDocument()
    expect(screen.getByText(duration)).toBeInTheDocument()
  })

  it('makes no size or time claim when the size is unknown', () => {
    open(null)
    continueToPreflight()
    expect(screen.getByText('everything currently in this graph')).toBeInTheDocument()
    expect(screen.getByText(/large models can take a few minutes/)).toBeInTheDocument()
  })
})
