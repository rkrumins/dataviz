/**
 * MessageHistoryChip — "what did that toast say?"
 *
 * Toasts vanish after 4.5 seconds and the app fires hundreds of them; a user
 * who looked away has no way back. The chip sits in the canvas status cluster
 * and opens the messages that appeared in THIS view, newest first. It is bound
 * to the open view (CanvasRouter clears the log on every view change) and lives
 * in memory only.
 *
 * Under test: it stays out of the way when there is nothing to show, it counts
 * correctly, its popover is portaled to the body (a status-cluster child would
 * be clipped and would inherit `pointer-events-none`), runs of the identical
 * message fold into one ×N row, and it closes the way every canvas surface
 * does — Escape, outside click, or the chip itself.
 */
import { render, screen, within, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MessageHistoryChip } from '../MessageHistoryChip'
import { useToastStore } from '@/components/ui/toast'

beforeEach(() => {
  useToastStore.setState({ toasts: [], history: [], _nextId: 1 })
})
afterEach(cleanup)

/** Seed history the way addToast does — newest first. */
function seed(messages: { type: 'success' | 'error' | 'warning' | 'info'; message: string }[]) {
  const { addToast } = useToastStore.getState()
  messages.forEach(m => addToast(m))
}

describe('MessageHistoryChip', () => {
  it('renders nothing when no message has appeared', () => {
    const { container } = render(<MessageHistoryChip />)
    expect(container).toBeEmptyDOMElement()
  })

  it('counts messages, singular and plural', async () => {
    seed([{ type: 'success', message: 'View saved' }])
    const { rerender } = render(<MessageHistoryChip />)
    expect(screen.getByRole('button', { name: /1 message$/i })).toBeInTheDocument()

    seed([
      { type: 'info', message: 'Layout applied' },
      { type: 'error', message: 'Load failed' },
    ])
    rerender(<MessageHistoryChip />)
    expect(await screen.findByRole('button', { name: /3 messages/i })).toBeInTheDocument()
  })

  it('opens a dialog listing the messages newest first, and the chip reports its state', async () => {
    const user = userEvent.setup()
    seed([
      { type: 'success', message: 'View saved' },
      { type: 'warning', message: 'Some edges were skipped' },
      { type: 'error', message: 'Load failed' },
    ])
    render(<MessageHistoryChip />)

    const chip = screen.getByRole('button', { name: /3 messages/i })
    expect(chip).toHaveAttribute('aria-expanded', 'false')

    await user.click(chip)
    const dialog = await screen.findByRole('dialog', { name: /messages in this view/i })
    expect(chip).toHaveAttribute('aria-expanded', 'true')

    const rows = within(dialog).getAllByRole('listitem')
    expect(rows.map(r => r.textContent)).toEqual([
      expect.stringContaining('Load failed'),
      expect.stringContaining('Some edges were skipped'),
      expect.stringContaining('View saved'),
    ])
  })

  it('portals the dialog outside the status-chip cluster', async () => {
    const user = userEvent.setup()
    seed([{ type: 'info', message: 'Layout applied' }])
    render(
      <div data-testid="cluster" className="pointer-events-none">
        <MessageHistoryChip />
      </div>,
    )

    await user.click(screen.getByRole('button', { name: /1 message/i }))
    const dialog = await screen.findByRole('dialog')
    expect(screen.getByTestId('cluster')).not.toContainElement(dialog)
    expect(document.body).toContainElement(dialog)
  })

  it('folds adjacent identical messages into one row with a ×N count', async () => {
    const user = userEvent.setup()
    seed([
      { type: 'info', message: 'Loading more' },
      { type: 'info', message: 'Loading more' },
      { type: 'info', message: 'Loading more' },
      { type: 'success', message: 'View saved' },
    ])
    render(<MessageHistoryChip />)

    // The chip counts MESSAGES, not rows.
    await user.click(screen.getByRole('button', { name: /4 messages/i }))
    const dialog = await screen.findByRole('dialog')

    const rows = within(dialog).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('View saved')
    expect(rows[0].textContent).not.toContain('×')
    expect(rows[1].textContent).toContain('Loading more')
    expect(rows[1].textContent).toContain('×3')
  })

  it('Clear empties the log, which takes the chip with it', async () => {
    const user = userEvent.setup()
    seed([{ type: 'success', message: 'View saved' }])
    render(<MessageHistoryChip />)

    await user.click(screen.getByRole('button', { name: /1 message/i }))
    await user.click(await screen.findByRole('button', { name: /clear/i }))

    expect(useToastStore.getState().history).toEqual([])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /message/i })).not.toBeInTheDocument()
  })

  it('does not re-open itself when a new toast arrives after Clear', async () => {
    const user = userEvent.setup()
    seed([{ type: 'success', message: 'View saved' }])
    render(<MessageHistoryChip />)

    await user.click(screen.getByRole('button', { name: /1 message/i }))
    await user.click(await screen.findByRole('button', { name: /clear/i }))

    // The chip is gone, but the component is still mounted alongside its
    // sibling chips. The next toast the app raises must bring back a CLOSED
    // chip — not a panel the user never asked for, over the canvas.
    seed([{ type: 'info', message: 'Saved to draft.' }])
    const chip = await screen.findByRole('button', { name: /1 message/i })
    expect(chip).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('does not re-open itself after a view change clears the log', async () => {
    const user = userEvent.setup()
    seed([{ type: 'success', message: 'View saved' }])
    render(<MessageHistoryChip />)

    await user.click(screen.getByRole('button', { name: /1 message/i }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    // CanvasRouter clears the history on every view/branch change, with the
    // panel still open. The new view's first toast must not pop it back open.
    useToastStore.getState().clearHistory()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    seed([{ type: 'error', message: 'Load failed' }])

    const chip = await screen.findByRole('button', { name: /1 message/i })
    expect(chip).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    seed([{ type: 'success', message: 'View saved' }])
    render(<MessageHistoryChip />)

    await user.click(screen.getByRole('button', { name: /1 message/i }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes on the chip itself and on an outside mousedown', async () => {
    const user = userEvent.setup()
    seed([{ type: 'success', message: 'View saved' }])
    render(
      <>
        <button type="button">elsewhere</button>
        <MessageHistoryChip />
      </>,
    )

    const chip = screen.getByRole('button', { name: /1 message/i })
    await user.click(chip)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    await user.click(chip)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(chip)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'elsewhere' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
