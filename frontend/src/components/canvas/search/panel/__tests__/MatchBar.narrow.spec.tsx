/**
 * Narrow… on the match bar: the canvas shows only the search's matches (and
 * what they reach). Offered for matches once a search has some — never for a
 * Connections search, whose answer is edges, nor where the canvas cannot.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MatchBar } from '../MatchBar'

describe('MatchBar — Narrow…', () => {
  it('narrows the canvas to the matches', () => {
    const onNarrow = vi.fn()
    render(<MatchBar count={47} elapsedMs={12} isRunning={false} unit="match" viewId="v1" onNarrow={onNarrow} />)
    fireEvent.click(screen.getByRole('button', { name: /Narrow…/ }))
    expect(onNarrow).toHaveBeenCalledOnce()
  })

  it.each([
    ['while it is running', { isRunning: true, count: 3, unit: 'match' as const }],
    ['with no matches', { isRunning: false, count: 0, unit: 'match' as const }],
    ['for connections', { isRunning: false, count: 3, unit: 'connection' as const }],
  ])('is not offered %s', (_when, props) => {
    render(<MatchBar elapsedMs={12} viewId="v1" onNarrow={vi.fn()} {...props} />)
    expect(screen.queryByRole('button', { name: /Narrow…/ })).not.toBeInTheDocument()
  })
})
