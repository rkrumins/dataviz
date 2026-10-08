/**
 * EnableVersioningFlow — what the user is told before turning version control on: how big the
 * copy is and roughly how long it may take (a bucket, never an invented number), and that
 * duplicate identifiers are checked first, with nothing copied until they decide.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../hooks/useVersioning', () => ({
  useBootstrapGraph: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))

import { EnableVersioningFlow } from '../EnableVersioningFlow'

const open = (itemCount?: number | null) =>
  render(<EnableVersioningFlow open onClose={vi.fn()} wsId="ws1" dataSourceId="ds1" itemCount={itemCount} />)

describe('before the copy starts', () => {
  it('promises a duplicate check first, and that nothing is copied until the user decides', () => {
    open(1_000)
    expect(
      screen.getByText('We check for duplicate identifiers first; nothing is copied until you decide.'),
    ).toBeInTheDocument()
  })

  it.each([
    [150_000, /about 150,000 items/, /usually done in a couple of minutes/],
    [1_200_000, /about 1,200,000 items/, /usually done within half an hour/],
    [9_000_000, /about 9,000,000 items/, /can take an hour or more/],
  ])('sizes a %d-item graph and says roughly how long it takes', (count, size, duration) => {
    open(count)
    expect(screen.getByText(size)).toBeInTheDocument()
    expect(screen.getByText(duration)).toBeInTheDocument()
  })

  it('makes no size or time claim when the size is unknown', () => {
    open(null)
    expect(screen.getByText('everything currently in this graph')).toBeInTheDocument()
    expect(screen.getByText(/large models can take a few minutes/)).toBeInTheDocument()
  })
})
