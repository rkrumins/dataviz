/**
 * Save as view… on the match bar: the search's matches kept as a subset view.
 * Offered for matches once a search has some, like Narrow… — never for a
 * Connections search, whose answer is edges. A search that can't be kept says
 * why on the button rather than hiding it.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MatchBar } from '../MatchBar'

describe('MatchBar — Save as view…', () => {
  it('keeps the matches as a view', () => {
    const onSaveAsView = vi.fn()
    render(<MatchBar count={47} elapsedMs={12} isRunning={false} unit="match" viewId="v1" onSaveAsView={onSaveAsView} />)
    fireEvent.click(screen.getByRole('button', { name: /Save as view…/ }))
    expect(onSaveAsView).toHaveBeenCalledOnce()
  })

  it('says what it does when it updates a subset instead', () => {
    render(<MatchBar count={3} elapsedMs={12} isRunning={false} unit="match" viewId="v1"
      onSaveAsView={vi.fn()} saveAsViewLabel="Update “PII”…" />)
    expect(screen.getByRole('button', { name: /Update “PII”…/ })).toBeInTheDocument()
  })

  it('says why a search can’t be kept, and does nothing', () => {
    const onSaveAsView = vi.fn()
    render(<MatchBar count={3} elapsedMs={12} isRunning={false} unit="match" viewId="v1"
      onSaveAsView={onSaveAsView} saveAsViewBlocked="A search that follows lineage can’t be kept as a view yet." />)
    const button = screen.getByRole('button', { name: /Save as view…/ })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('title', 'A search that follows lineage can’t be kept as a view yet.')
    fireEvent.click(button)
    expect(onSaveAsView).not.toHaveBeenCalled()
  })

  it.each([
    ['while it is running', { isRunning: true, count: 3, unit: 'match' as const }],
    ['with no matches', { isRunning: false, count: 0, unit: 'match' as const }],
    ['for connections', { isRunning: false, count: 3, unit: 'connection' as const }],
  ])('is not offered %s', (_when, props) => {
    render(<MatchBar elapsedMs={12} viewId="v1" onSaveAsView={vi.fn()} {...props} />)
    expect(screen.queryByRole('button', { name: /Save as view…/ })).not.toBeInTheDocument()
  })
})
