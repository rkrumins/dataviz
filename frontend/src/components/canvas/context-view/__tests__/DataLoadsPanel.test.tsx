/**
 * DataLoadsPanel — "what did that notification say?", docked where it can be
 * clicked.
 *
 * Notifications live 4.5 seconds and the app fires hundreds of them; a user who looked
 * away has no way back. The messages this view raised now live in a panel
 * docked directly above Connections in the canvas's bottom-right stack — the
 * chip that used to open them sat in the status cluster and the expanded
 * Connections body covered it, so it could not be clicked at all.
 *
 * Under test: it stays out of the way when there is nothing to show; its
 * collapsed header is the first button and carries the band-reservation hook
 * (`data-dock-header`); the log reads NEWEST FIRST — what you just did is what
 * happened; runs of the identical message fold into one ×N row that keeps the
 * LATEST time; every time carries the absolute clock time in its title; Clear
 * takes the panel with it; and nothing is portaled — the panel renders inside
 * the dock, which is the whole point of moving it there.
 *
 * And that each entry is a CARD — the shape of the notification it records —
 * carrying ONE glyph. The panel used to be flat 12px rows with two indicators
 * apiece: a timeline rail dot AND a status icon, saying the same thing twice.
 */
import { render, screen, within, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DataLoadsPanel } from '../DataLoadsPanel'
import { useNotificationStore, type NotificationHistoryEntry } from '@/components/ui/notifications'
import { aggregationService, type DataSourceReadinessResponse } from '@/services/aggregationService'

vi.mock('@/services/aggregationService', () => ({
  aggregationService: { getReadiness: vi.fn() },
}))
const readiness = vi.mocked(aggregationService.getReadiness)

/**
 * The only field on the readiness reading this panel is allowed to believe.
 * `isReady` stays TRUE while a source's connections trail behind — that is the
 * whole reason a finished load and a load that is not queryable yet looked
 * identical here.
 */
const reading = (projectorCurrent: boolean | null) =>
  ({ isReady: true, projectorCurrent } as unknown as DataSourceReadinessResponse)

const HOUR = 60 * 60 * 1000

beforeEach(() => {
  useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
  readiness.mockReset()
  readiness.mockResolvedValue(reading(null))
})
afterEach(cleanup)

type Seed = Pick<NotificationHistoryEntry, 'type' | 'message' | 'createdAt'>

/** Seed the store the way add does — NEWEST first — from an oldest-first list. */
function seed(oldestFirst: Seed[]) {
  const history = oldestFirst.map((e, i) => ({ id: i + 1, ...e })).reverse()
  useNotificationStore.setState({ history, _nextId: oldestFirst.length + 1 })
}

const header = () => screen.getByRole('button', { name: /data loads/i })
const rows = () => screen.getAllByRole('listitem')

describe('DataLoadsPanel', () => {
  it('renders nothing when no message has appeared', () => {
    const { container } = render(<DataLoadsPanel />)
    expect(container).toBeEmptyDOMElement()
  })

  it('the collapsed header is the first button, names the log, counts it, and reserves the band', () => {
    seed([
      { type: 'success', message: 'View saved', createdAt: Date.now() - 3 * HOUR },
      { type: 'info', message: 'Layout applied', createdAt: Date.now() - 2 * HOUR },
      { type: 'error', message: 'Load failed', createdAt: Date.now() - HOUR },
    ])
    const { container } = render(<DataLoadsPanel />)

    // ContextViewCanvas's measureLegendHeader sums every [data-dock-header] in
    // the dock; without this attribute the Data loads header is not reserved and
    // the bottom row of every column slides under the stack.
    const first = container.querySelector('button')
    expect(first).toBe(header())
    expect(first).toHaveAttribute('data-dock-header')
    expect(first).toHaveAttribute('aria-expanded', 'false')
    expect(first).toHaveTextContent('Data loads')
    expect(first).toHaveTextContent('3')
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })

  it('lists every message NEWEST FIRST — what just happened needs no scrolling', async () => {
    const user = userEvent.setup()
    seed([
      { type: 'success', message: 'View saved', createdAt: Date.now() - 3 * HOUR },
      { type: 'warning', message: 'Some edges were skipped', createdAt: Date.now() - 2 * HOUR },
      { type: 'error', message: 'Load failed', createdAt: Date.now() - HOUR },
    ])
    render(<DataLoadsPanel />)

    await user.click(header())
    expect(header()).toHaveAttribute('aria-expanded', 'true')
    expect(rows().map(r => r.textContent)).toEqual([
      expect.stringContaining('Load failed'),
      expect.stringContaining('Some edges were skipped'),
      expect.stringContaining('View saved'),
    ])
    // The header stays the first button even opened — the band depends on it.
    expect(screen.getByRole('region', { name: /data loads/i })).toBeInTheDocument()
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
    render(<DataLoadsPanel />)

    // The header counts MESSAGES, not rows.
    expect(header()).toHaveTextContent('4')
    await user.click(header())

    const list = rows()
    expect(list).toHaveLength(2)
    expect(list[0].textContent).toContain('View saved')
    expect(list[0].textContent).not.toContain('×')
    expect(list[1].textContent).toContain('Loading more')
    expect(list[1].textContent).toContain('×3')

    // The run happened three times; the row answers "when did it last happen?"
    expect(within(list[1]).getByTitle(new Date(latest).toLocaleTimeString())).toHaveTextContent('1h ago')
  })

  it('every row hands over the absolute clock time on hover', async () => {
    const user = userEvent.setup()
    const saved = Date.now() - 2 * HOUR
    const failed = Date.now() - HOUR
    seed([
      { type: 'success', message: 'View saved', createdAt: saved },
      { type: 'error', message: 'Load failed', createdAt: failed },
    ])
    render(<DataLoadsPanel />)

    await user.click(header())
    const list = rows()
    // Newest first: the failure (1h ago) is above the save (2h ago).
    expect(within(list[0]).getByTitle(new Date(failed).toLocaleTimeString())).toBeInTheDocument()
    expect(within(list[1]).getByTitle(new Date(saved).toLocaleTimeString())).toBeInTheDocument()
  })

  it('Clear empties the log, which takes the panel with it', async () => {
    const user = userEvent.setup()
    seed([{ type: 'success', message: 'View saved', createdAt: Date.now() }])
    const { container } = render(<DataLoadsPanel />)

    await user.click(header())
    await user.click(screen.getByRole('button', { name: /clear/i }))

    expect(useNotificationStore.getState().history).toEqual([])
    expect(container).toBeEmptyDOMElement()
  })

  it('does not spring back open when the next message refills the log', async () => {
    const user = userEvent.setup()
    seed([{ type: 'success', message: 'View saved', createdAt: Date.now() }])
    render(<DataLoadsPanel />)

    await user.click(header())
    await user.click(screen.getByRole('button', { name: /clear/i }))

    // The panel unmounted but its instance did not — the dock keeps it
    // rendered. The next notification must bring back a CLOSED panel, not one the
    // user never asked for, grown up over the canvas.
    seed([{ type: 'info', message: 'Saved to draft.', createdAt: Date.now() }])
    expect(await screen.findByRole('button', { name: /data loads/i })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })

  it('is not portaled — it renders inside the dock, where it can be clicked', async () => {
    const user = userEvent.setup()
    seed([{ type: 'info', message: 'Layout applied', createdAt: Date.now() }])
    const { container } = render(
      <div data-testid="dock">
        <DataLoadsPanel />
      </div>,
    )

    await user.click(header())
    const region = screen.getByRole('region', { name: /data loads/i })
    expect(screen.getByTestId('dock')).toContainElement(region)
    expect(container).toContainElement(region)
  })


  it('keeps counting while the log is open — a minute-old message stops saying "just now"', () => {
    vi.useFakeTimers()
    try {
      const start = Date.now()
      seed([{ type: 'success', message: 'Entities loaded', createdAt: start }])
      render(<DataLoadsPanel />)
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

  it('every entry is a card, with the status as a 2px accent down its left', async () => {
    const user = userEvent.setup()
    seed([
      { type: 'success', message: 'Opened “Customer 360” · 1,204 items', createdAt: Date.now() - 2 * HOUR },
      { type: 'error', message: 'Snowflake · nothing more to load', createdAt: Date.now() - HOUR },
    ])
    render(<DataLoadsPanel />)
    await user.click(header())

    for (const card of rows()) {
      // NotificationCard's shape, one size down: its own surface, a hairline
      // border, and room to breathe.
      expect(card.className).toMatch(/rounded-lg/)
      expect(card.className).toMatch(/border-glass-border/)
      expect(card.className).toMatch(/px-3/)
      expect(card.className).toMatch(/py-2\.5/)
      // The notification wears its status as a bar along the bottom; here it
      // is a 2px stripe down the left.
      const accent = card.querySelector('[data-accent]') as HTMLElement | null
      expect(accent).not.toBeNull()
      expect(accent!.className).toContain('w-0.5')
    }
    // Newest first: the failure (1h ago) leads, the success (2h ago) follows.
    expect((rows()[0].querySelector('[data-accent]') as HTMLElement).className).toContain('text-red-500')
    expect((rows()[1].querySelector('[data-accent]') as HTMLElement).className).toContain('text-emerald-500')
  })

  it('carries ONE glyph per entry — the rail and its dot are gone', async () => {
    const user = userEvent.setup()
    seed([
      { type: 'success', message: 'Connections · 3,918', createdAt: Date.now() - HOUR },
      { type: 'info', message: 'Placed 1,204 items across 6 layers', createdAt: Date.now() },
    ])
    render(<DataLoadsPanel />)
    await user.click(header())

    for (const card of rows()) {
      expect(card.querySelectorAll('svg')).toHaveLength(1)
      // The per-row dot and the newest-row halo were both `rounded-full`.
      expect(card.querySelectorAll('[class*="rounded-full"]')).toHaveLength(0)
    }
    // With cards in order and a time on every one, the rail said nothing the
    // sequence did not already say.
    const list = screen.getByRole('list')
    expect(list.className).not.toMatch(/\brelative\b/)
    expect(list.querySelectorAll('[class*="w-px"]')).toHaveLength(0)
  })

  it('marks the newest card, so "where did I get to" needs no reading', async () => {
    const user = userEvent.setup()
    seed([
      { type: 'info', message: 'Opening “Customer 360”…', createdAt: Date.now() - 2 * HOUR },
      { type: 'success', message: 'Snowflake · 5 datasets', createdAt: Date.now() - HOUR },
    ])
    render(<DataLoadsPanel />)
    await user.click(header())

    const list = rows()
    // Newest first, so the marked card is the one at the top.
    expect(list[0].className).toMatch(/ring-1/)
    expect(list[list.length - 1].className).not.toMatch(/ring-1/)
  })

  it('gives the message room to sit on one line at the notification\'s own width', async () => {
    const user = userEvent.setup()
    seed([{ type: 'success', message: 'Snowflake · 5 more (10 of 41)', createdAt: Date.now() }])
    render(<DataLoadsPanel />)
    await user.click(header())

    const [card] = rows()
    // Never truncated — a log whose messages end in "…" answers nothing.
    const message = screen.getByText(/Snowflake · 5 more/)
    expect(message.className).toContain('text-[13px]')
    expect(message.className).not.toMatch(/truncate|text-ellipsis/)
    const time = card.querySelector('time') as HTMLElement
    expect(time.className).toContain('text-[11px]')
    expect(time.className).toContain('tabular-nums')
  })

  it('the count is announced as messages, and the sequence is a list', () => {
    const now = Date.now()
    seed([
      { type: 'success', message: 'Entities loaded', createdAt: now - 2000 },
      { type: 'success', message: 'Edges loaded', createdAt: now - 1000 },
    ])
    render(<DataLoadsPanel />)
    expect(screen.getByLabelText('2 messages')).toBeInTheDocument()
    fireEvent.click(header())
    expect(screen.getByRole('list')).toBeInTheDocument()
  })
})

/**
 * A load can FINISH and still not be on the canvas.
 *
 * On a version-controlled source the connections between things are rebuilt
 * after the load lands. While that is behind, a main read serves the data
 * WITHOUT them: the message said "loaded" and it was true, and the lineage was
 * missing anyway. In the log those two loads looked identical — same green
 * tick, same time — which is the silence this panel exists to end.
 *
 * The reading comes from the readiness endpoint's `projectorCurrent`. NOT
 * `isReady`: that reports the load job alone and stays true under a wedge.
 * `false` is the only affirmative "not yet" — null is UNKNOWN (an unversioned
 * source, an unreadable store) and must never be rendered as either answer.
 *
 * The cut is per LOAD, not per panel: the last instant we saw the connections
 * up to date. Loads before it are on the canvas; loads after it are waiting.
 */
describe('DataLoadsPanel · a published load whose connections have not caught up', () => {
  const noteText = /connections still catching up/i

  it('marks the load on its own row, and says so from the collapsed header', async () => {
    readiness.mockResolvedValue(reading(false))
    seed([
      { type: 'success', message: 'Snowflake · 5 datasets', createdAt: Date.now() - 2 * HOUR },
      { type: 'success', message: 'Snowflake · 3 more datasets', createdAt: Date.now() - HOUR },
    ])
    render(<DataLoadsPanel dataSourceId="ds-1" />)

    // Collapsed, the panel is one line of chrome — the truth cannot live only
    // behind a click nobody knows to make.
    expect(await screen.findByText('Catching up')).toBeInTheDocument()

    fireEvent.click(header())
    const list = rows()
    expect(list).toHaveLength(2)
    for (const card of list) {
      expect(card).toHaveAttribute('data-waiting')
      expect(within(card).getByText(noteText)).toBeInTheDocument()
    }
    // The load is saved — the reader has nothing to redo, and is told so once.
    expect(screen.getByText(/nothing to redo/i)).toBeInTheDocument()

    // The mark has to survive `cn`. twMerge keeps `dark:bg-*` in a group of
    // its own, so an amber that is only declared light-mode loses to the
    // card's own `dark:bg-white/…` and the row reads unmarked in dark mode —
    // marked in the DOM, invisible on the screen.
    expect(list[0].className).toContain('bg-amber-500/10')
    expect(list[0].className).toContain('dark:bg-amber-500/10')
    expect(list[0].className).not.toMatch(/dark:bg-white/)
  })

  it('says nothing at all when the connections are up to date', async () => {
    readiness.mockResolvedValue(reading(true))
    seed([{ type: 'success', message: 'Snowflake · 5 datasets', createdAt: Date.now() - HOUR }])
    render(<DataLoadsPanel dataSourceId="ds-1" />)

    await waitFor(() => expect(readiness).toHaveBeenCalledWith('ds-1'))
    await act(async () => {})

    expect(screen.queryByText('Catching up')).toBeNull()
    fireEvent.click(header())
    expect(rows()[0]).not.toHaveAttribute('data-waiting')
    expect(screen.queryByText(noteText)).toBeNull()
  })

  it('an UNKNOWN reading marks nothing — and never claims the load is up to date either', async () => {
    // null: not a versioned source, or the store could not be read. Unknown is
    // not healthy; the one thing it may not do is invent an answer.
    readiness.mockResolvedValue(reading(null))
    seed([{ type: 'success', message: 'Snowflake · 5 datasets', createdAt: Date.now() - HOUR }])
    const { container } = render(<DataLoadsPanel dataSourceId="ds-1" />)

    await waitFor(() => expect(readiness).toHaveBeenCalledWith('ds-1'))
    await act(async () => {})

    fireEvent.click(header())
    expect(screen.queryByText(noteText)).toBeNull()
    expect(rows()[0]).not.toHaveAttribute('data-waiting')
    expect(container.textContent).not.toMatch(/up to date|caught up/i)
  })

  it('marks only the loads recorded SINCE the connections were last seen up to date', async () => {
    vi.useFakeTimers()
    try {
      const t0 = Date.now()
      readiness.mockResolvedValueOnce(reading(true))   // first reading: current at t0
      readiness.mockResolvedValue(reading(false))      // and behind ever after
      const early = { type: 'success' as const, message: 'Snowflake · 5 datasets', createdAt: t0 - 60_000 }
      seed([early])
      render(<DataLoadsPanel dataSourceId="ds-1" />)
      await act(async () => {})

      // A second load lands five seconds after that known-good reading.
      vi.setSystemTime(t0 + 5_000)
      act(() => {
        seed([early, { type: 'success', message: 'Snowflake · 3 more datasets', createdAt: t0 + 5_000 }])
      })
      // …and the next reading finds the connections behind.
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })

      fireEvent.click(header())
      const list = rows()
      // Newest first. Only the load that arrived after the last good reading
      // is waiting — the earlier one is already on the canvas, and saying
      // otherwise would be the banner repeated per row, not per-load truth.
      expect(list[0].textContent).toContain('3 more datasets')
      expect(list[0]).toHaveAttribute('data-waiting')
      expect(list[1].textContent).toContain('Snowflake · 5 datasets')
      expect(list[1]).not.toHaveAttribute('data-waiting')
      expect(screen.getAllByText(noteText)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the mark by itself the moment the connections catch up', async () => {
    vi.useFakeTimers()
    try {
      readiness.mockResolvedValueOnce(reading(false))
      readiness.mockResolvedValue(reading(true))
      seed([{ type: 'success', message: 'Snowflake · 5 datasets', createdAt: Date.now() - 60_000 }])
      render(<DataLoadsPanel dataSourceId="ds-1" />)
      await act(async () => {})

      fireEvent.click(header())
      expect(screen.getByText(noteText)).toBeInTheDocument()
      expect(screen.getByText('Catching up')).toBeInTheDocument()

      await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })

      expect(screen.queryByText(noteText)).toBeNull()
      expect(screen.queryByText('Catching up')).toBeNull()
      expect(rows()[0]).not.toHaveAttribute('data-waiting')
    } finally {
      vi.useRealTimers()
    }
  })

  it('never asks when the open view has no data source of its own', async () => {
    seed([{ type: 'success', message: 'View saved', createdAt: Date.now() }])
    render(<DataLoadsPanel />)
    await act(async () => {})
    expect(readiness).not.toHaveBeenCalled()
  })

  it('says it in plain language — no internals reach this panel', async () => {
    readiness.mockResolvedValue(reading(false))
    seed([{ type: 'success', message: 'Snowflake · 5 datasets', createdAt: Date.now() - HOUR }])
    const { container } = render(<DataLoadsPanel dataSourceId="ds-1" />)
    await screen.findByText('Catching up')
    fireEvent.click(header())

    // This panel is read by business users. The words below are what the
    // backend calls this state; none of them mean anything to a reader here.
    const shown = `${container.textContent} ${Array.from(container.querySelectorAll('[title]'))
      .map(el => el.getAttribute('title'))
      .join(' ')}`
    expect(shown).not.toMatch(/projection|watermark|commit[ _]?seq|AGGREGATED|roll[ -]?up/i)
  })
})
