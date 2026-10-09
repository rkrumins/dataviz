/**
 * CanvasProviderStateOverlay — a session the fetch layer could not repair is
 * said as such, with the one action that fixes it.
 *
 * Regression under test: a 401 / CSRF 403 reached the canvas as 'slow', so an
 * SSO user whose session broke saw "Taking a little longer than usual" on
 * every view, forever. A reload is what reconnects it (bootstrap re-runs
 * /auth/me, or lands on /login), so the card names the problem and offers it.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CanvasProviderStateOverlay, CanvasProviderStatePill } from '../CanvasProviderStateOverlay'

const realLocation = window.location
const reload = vi.fn()

beforeEach(() => {
  reload.mockReset()
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, reload },
  })
})

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
})

describe('CanvasProviderStateOverlay — session', () => {
  it('says the session is reconnecting, not that the graph is slow', () => {
    render(<CanvasProviderStateOverlay state="session" onRetry={vi.fn()} />)
    expect(screen.getByText('Reconnecting your session')).toBeInTheDocument()
    expect(screen.queryByText(/taking a little longer/i)).not.toBeInTheDocument()
  })

  it('offers a page reload as its action', () => {
    const onRetry = vi.fn()
    render(<CanvasProviderStateOverlay state="session" onRetry={onRetry} />)
    fireEvent.click(screen.getByRole('button', { name: /reload page/i }))
    expect(reload).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('the pill over a canvas with data names it too, and keeps its retry', () => {
    const onRetry = vi.fn()
    render(<CanvasProviderStatePill state="session" partial={false} missingEntities={0} onRetry={onRetry} />)
    expect(screen.getByText('Reconnecting your session')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Retry now'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
