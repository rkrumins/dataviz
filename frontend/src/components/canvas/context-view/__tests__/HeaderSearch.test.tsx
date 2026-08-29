/**
 * HeaderSearch — the header box against a stubbed session.
 *
 * The box owns no search state of its own any more: every gesture is a
 * call on the one session the canvas provides, so each spec asserts on
 * the CALL rather than on what re-rendered. The two that don't — the
 * scope chip and the status line — read the session's own state back.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DEFAULT_QUICK } from '@/components/canvas/search/session/quickPredicate'
import { ViewSearchSessionContext } from '@/components/canvas/search/session/ViewSearchSessionContext'
import type { ViewSearchSession } from '@/components/canvas/search/session/useViewSearchSessionController'
import type { PanelView } from '@/hooks/useAdvancedSearch'
import { stubAdvanced, stubSession } from '@/test/stubSearchSession'

import { HeaderSearch } from '../header/HeaderSearch'

const BOX = /search this view/i

function renderBox(session: ViewSearchSession) {
  render(
    <ViewSearchSessionContext.Provider value={session}>
      <HeaderSearch />
    </ViewSearchSessionContext.Provider>,
  )
}

/** A finished run. Only `result` is read by the status line; the
 *  template/inputs/query half of the view belongs to the panel. */
function resultsView(result: Record<string, unknown>): PanelView {
  return {
    kind: 'results', template: {}, inputs: {}, query: {},
    result, elapsedMs: 12,
  } as unknown as PanelView
}

describe('HeaderSearch', () => {
  it('sends what was typed to the session', () => {
    const session = stubSession()
    renderBox(session)

    fireEvent.change(screen.getByPlaceholderText(BOX), { target: { value: 'orders' } })

    expect(session.setQuick).toHaveBeenCalledWith({ text: 'orders' })
  })

  it('runs on Enter', () => {
    const session = stubSession({ quick: { ...DEFAULT_QUICK, text: 'orders' } })
    renderBox(session)

    fireEvent.keyDown(screen.getByPlaceholderText(BOX), { key: 'Enter' })

    expect(session.runNow).toHaveBeenCalledTimes(1)
  })

  it('clears the whole query on Escape', () => {
    const session = stubSession({ quick: { ...DEFAULT_QUICK, text: 'orders' } })
    renderBox(session)

    fireEvent.keyDown(screen.getByPlaceholderText(BOX), { key: 'Escape' })

    expect(session.clearQuery).toHaveBeenCalledTimes(1)
  })

  it('shows the container a scoped search is clamped to, and unclamps it', () => {
    const session = stubSession({
      quick: { ...DEFAULT_QUICK, scope: { insideUrn: 't1', label: 'orders' } },
    })
    renderBox(session)

    expect(screen.getByText('inside orders')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /search the whole view/i }))
    expect(session.clearScope).toHaveBeenCalledTimes(1)
  })

  it('picks a match mode by its builder label', () => {
    const session = stubSession()
    renderBox(session)

    fireEvent.click(screen.getByRole('button', { name: /match/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Starts with' }))

    expect(session.setQuick).toHaveBeenCalledWith({ match: 'prefix' })
  })

  it('opens the builder from Refine', () => {
    const session = stubSession()
    renderBox(session)

    fireEvent.click(screen.getByRole('button', { name: /refine/i }))

    expect(session.refine).toHaveBeenCalledTimes(1)
  })

  it('reports the whole candidate count, not the page it rendered', () => {
    const session = stubSession({
      advanced: stubAdvanced({
        view: resultsView({ candidateCount: 1284, truncated: false, hits: [] }),
      }),
    })
    renderBox(session)

    expect(screen.getByText(/1,284 matches/)).toBeInTheDocument()
  })
})
