/**
 * Edit properties… on the match bar: a property changed on every match of the search — all of
 * them, not only the loaded ones. Offered for matches once a search has some — never for a
 * Connections search, whose answer is edges, nor where the canvas cannot write.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MatchBar } from '../MatchBar'

describe('MatchBar — Edit properties…', () => {
  it('changes a property on the matches', () => {
    const onEditProperties = vi.fn()
    render(<MatchBar count={47} elapsedMs={12} isRunning={false} unit="match" viewId="v1" onEditProperties={onEditProperties} />)
    fireEvent.click(screen.getByRole('button', { name: /Edit properties…/ }))
    expect(onEditProperties).toHaveBeenCalledOnce()
  })

  it.each([
    ['while it is running', { isRunning: true, count: 3, unit: 'match' as const }],
    ['with no matches', { isRunning: false, count: 0, unit: 'match' as const }],
    ['for connections', { isRunning: false, count: 3, unit: 'connection' as const }],
  ])('is not offered %s', (_when, props) => {
    render(<MatchBar elapsedMs={12} viewId="v1" onEditProperties={vi.fn()} {...props} />)
    expect(screen.queryByRole('button', { name: /Edit properties…/ })).not.toBeInTheDocument()
  })
})
