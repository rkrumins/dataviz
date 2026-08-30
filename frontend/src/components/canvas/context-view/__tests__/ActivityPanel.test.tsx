/**
 * ActivityPanel — "what did that notification say?", docked where it can be clicked.
 *
 * Notifications live 4.5 seconds and the app fires hundreds of them; a user who looked
 * away has no way back. The messages this view raised now live in a panel
 * docked directly above Connections in the canvas's bottom-right stack — the
 * chip that used to open them sat in the status cluster and the expanded
 * Connections body covered it, so it could not be clicked at all.
 *
 * Under test: it stays out of the way when there is nothing to show; its
 * collapsed header is the first button and carries the band-reservation hook
 * (`data-dock-header`); the log reads OLDEST FIRST — the order things actually
 * happened; runs of the identical message fold into one ×N row that keeps the
 * LATEST time; every time carries the absolute clock time in its title; Clear
 * takes the panel with it; and nothing is portaled — the panel renders inside
 * the dock, which is the whole point of moving it there.
 */
import { render, screen, within, cleanup, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ActivityPanel } from '../ActivityPanel'
import { useNotificationStore, type NotificationHistoryEntry } from '@/components/ui/notifications'

const HOUR = 60 * 60 * 1000

beforeEach(() => {
  useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
})
afterEach(cleanup)

type Seed = Pick<NotificationHistoryEntry, 'type' | 'message' | 'createdAt'>

/** Seed the store the way add does — NEWEST first — from an oldest-first list. */
function seed(oldestFirst: Seed[]) {
  const history = oldestFirst.map((e, i) => ({ id: i + 1, ...e })).reverse()
  useNotificationStore.setState({ history, _nextId: oldestFirst.length + 1 })
}

const header = () => screen.getByRole('button', { name: /activity/i })
const rows = () => screen.getAllByRole('listitem')

describe('ActivityPanel', () => {
  it('renders nothing when no message has appeared', () => {
    const { container } = render(<ActivityPanel />)
    expect(container).toBeEmptyDOMElement()
  })

  it('the collapsed header is the first button, names the log, counts it, and reserves the band', () => {
    seed([
      { type: 'success', message: 'View saved', createdAt: Date.now() - 3 * HOUR },
      { type: 'info', message: 'Layout applied', createdAt: Date.now() - 2 * HOUR },
      { type: 'error', message: 'Load failed', createdAt: Date.now() - HOUR },
    ])
    const { container } = render(<ActivityPanel />)

    // ContextViewCanvas's measureLegendHeader sums every [data-dock-header] in
    // the dock; without this attribute the Activity header is not reserved and
    // the bottom row of every column slides under the stack.
    const first = container.querySelector('button')
    expect(first).toBe(header())
    expect(first).toHaveAttribute('data-dock-header')
    expect(first).toHaveAttribute('aria-expanded', 'false')
    expect(first).toHaveTextContent('Activity')
    expect(first).toHaveTextContent('3')
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })

  it('lists every message OLDEST FIRST — the order things actually happened', async () => {
    const user = userEvent.setup()
    seed([
      { type: 'success', message: 'View saved', createdAt: Date.now() - 3 * HOUR },
      { type: 'warning', message: 'Some edges were skipped', createdAt: Date.now() - 2 * HOUR },
      { type: 'error', message: 'Load failed', createdAt: Date.now() - HOUR },
    ])
    render(<ActivityPanel />)

    await user.click(header())
    expect(header()).toHaveAttribute('aria-expanded', 'true')
    expect(rows().map(r => r.textContent)).toEqual([
      expect.stringContaining('View saved'),
      expect.stringContaining('Some edges were skipped'),
      expect.stringContaining('Load failed'),
    ])
    // The header stays the first button even opened — the band depends on it.
    expect(screen.getByRole('region', { name: /activity/i })).toBeInTheDocument()
  })

  it('folds a run of the identical message into one ×N row that keeps the LATEST time', async () => {
    const user = userEvent.setup()
    const latest = Date.now() - HOUR
    seed([
      { type: 'info', message: 'Loading more', createdAt: Date.now() - 3 * HOUR },
      { type: 'info', message: 'Loading more', createdAt: Date.now() - 2 * HOUR },
      { type: 'info', message: 'Loading more', createdAt: latest },
      { type: 'success', message: 'View saved', createdAt: Date.now() - 30 * 60 * 1000 },
    ])
    render(<ActivityPanel />)

    // The header counts MESSAGES, not rows.
    expect(header()).toHaveTextContent('4')
    await user.click(header())

    const list = rows()
    expect(list).toHaveLength(2)
    expect(list[0].textContent).toContain('Loading more')
    expect(list[0].textContent).toContain('×3')
    expect(list[1].textContent).toContain('View saved')
    expect(list[1].textContent).not.toContain('×')

    // The run happened three times; the row answers "when did it last happen?"
    expect(within(list[0]).getByTitle(new Date(latest).toLocaleTimeString())).toHaveTextContent('1h ago')
  })

  it('every row hands over the absolute clock time on hover', async () => {
    const user = userEvent.setup()
    const saved = Date.now() - 2 * HOUR
    const failed = Date.now() - HOUR
    seed([
      { type: 'success', message: 'View saved', createdAt: saved },
      { type: 'error', message: 'Load failed', createdAt: failed },
    ])
    render(<ActivityPanel />)

    await user.click(header())
    const list = rows()
    expect(within(list[0]).getByTitle(new Date(saved).toLocaleTimeString())).toBeInTheDocument()
    expect(within(list[1]).getByTitle(new Date(failed).toLocaleTimeString())).toBeInTheDocument()
  })

  it('Clear empties the log, which takes the panel with it', async () => {
    const user = userEvent.setup()
    seed([{ type: 'success', message: 'View saved', createdAt: Date.now() }])
    const { container } = render(<ActivityPanel />)

    await user.click(header())
    await user.click(screen.getByRole('button', { name: /clear/i }))

    expect(useNotificationStore.getState().history).toEqual([])
    expect(container).toBeEmptyDOMElement()
  })

  it('does not spring back open when the next message refills the log', async () => {
    const user = userEvent.setup()
    seed([{ type: 'success', message: 'View saved', createdAt: Date.now() }])
    render(<ActivityPanel />)

    await user.click(header())
    await user.click(screen.getByRole('button', { name: /clear/i }))

    // The panel unmounted but its instance did not — the dock keeps it
    // rendered. The next notification must bring back a CLOSED panel, not one the
    // user never asked for, grown up over the canvas.
    seed([{ type: 'info', message: 'Saved to draft.', createdAt: Date.now() }])
    expect(await screen.findByRole('button', { name: /activity/i })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })

  it('is not portaled — it renders inside the dock, where it can be clicked', async () => {
    const user = userEvent.setup()
    seed([{ type: 'info', message: 'Layout applied', createdAt: Date.now() }])
    const { container } = render(
      <div data-testid="dock">
        <ActivityPanel />
      </div>,
    )

    await user.click(header())
    const region = screen.getByRole('region', { name: /activity/i })
    expect(screen.getByTestId('dock')).toContainElement(region)
    expect(container).toContainElement(region)
  })


  it('keeps counting while the log is open — a minute-old message stops saying "just now"', () => {
    vi.useFakeTimers()
    try {
      const start = Date.now()
      seed([{ type: 'success', message: 'Entities loaded', createdAt: start }])
      render(<ActivityPanel />)
      fireEvent.click(header())
      expect(screen.getByText('just now')).toBeInTheDocument()
      // Past the minute boundary, with the panel still open and untouched.
      vi.setSystemTime(start + 61_000)
      act(() => { vi.advanceTimersByTime(30_000) })
      expect(screen.queryByText('just now')).toBeNull()
      expect(screen.getByText('1m ago')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the count is announced as messages, and the sequence is a list', () => {
    const now = Date.now()
    seed([
      { type: 'success', message: 'Entities loaded', createdAt: now - 2000 },
      { type: 'success', message: 'Edges loaded', createdAt: now - 1000 },
    ])
    render(<ActivityPanel />)
    expect(screen.getByLabelText('2 messages')).toBeInTheDocument()
    fireEvent.click(header())
    expect(screen.getByRole('list')).toBeInTheDocument()
  })
})
