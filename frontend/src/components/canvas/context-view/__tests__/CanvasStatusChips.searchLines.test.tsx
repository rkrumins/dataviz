/**
 * A Connections search lights more lines than its budget draws (On Hover,
 * Adaptive): the chip says how many more, and where to see every one.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { CanvasStatusChips } from '../CanvasStatusChips'

const chips = (searchShown: number, searchTotal: number) => render(
  <CanvasStatusChips unresolvedEdgeCount={0} unassignedEntities={[]} aggDetailShown={0} aggDetailTotal={0}
    searchShown={searchShown} searchTotal={searchTotal} />,
)

describe('CanvasStatusChips — matched lines past the budget', () => {
  it('says how many lit lines are not drawn, and where to see them all', async () => {
    chips(1000, 1240)
    const label = screen.getByText('240')
    expect(label.parentElement).toHaveTextContent('240 more matched lines not drawn')
    fireEvent.focus(label.parentElement!.parentElement!)
    expect((await screen.findAllByText(/The search lights 1,240 lines — drawing the 1,000 with the most matches/)).length)
      .toBeGreaterThan(0)
  })

  it('says nothing while every lit line is drawn', () => {
    const { container } = chips(12, 12)
    expect(container).toBeEmptyDOMElement()
  })
})
