/**
 * The canvas says when placements point at nothing: entities placed in the view that this source
 * doesn't hold now — deleted, given a new URN, or placed in another environment; from here it is
 * only known that they are not here. The chip lists them (named, with their layer) and offers to
 * clean them up — in a draft; outside one, the way into a draft. Nothing is removed until asked.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CanvasStatusChips } from '../CanvasStatusChips'

const PLACEMENTS = [
  { urn: 'urn:li:dataset:(hive,finance.orders,PROD)', label: 'orders', layerName: 'Sources' },
  { urn: 'urn:li:dataset:(hive,finance.ledger,PROD)', label: 'ledger', layerName: 'Marts' },
]

function renderChips(notFoundPlacements = PLACEMENTS, props: { onCleanUpNotFound?: () => void; onOpenDraft?: () => void } = {}) {
  return render(
    <CanvasStatusChips unresolvedEdgeCount={0} unassignedEntities={[]} aggDetailShown={0} aggDetailTotal={0}
      notFoundPlacements={notFoundPlacements} {...props} />,
  )
}
const openChip = () =>
  fireEvent.click(screen.getByRole('button', { name: '2 placements point at entities no longer in this source' }))

describe('CanvasStatusChips — placements that point at entities no longer in this source', () => {
  it('counts them, and lists them with their layers, saying only what is known', () => {
    renderChips()
    openChip()
    expect(screen.getByText('Placed here, but not in this source')).toBeInTheDocument()
    expect(screen.getByText('orders')).toBeInTheDocument()
    expect(screen.getByText('Marts')).toBeInTheDocument()
    expect(screen.getByText(
      'This source doesn’t hold these entities now — they may have been deleted, given a new URN, or placed in another environment. Until they’re cleaned up they stay placed, and show again if they come back.',
    )).toBeInTheDocument()
  })

  it('says one placement in the singular', () => {
    renderChips(PLACEMENTS.slice(0, 1))
    expect(screen.getByRole('button', { name: '1 placement points at an entity no longer in this source' })).toBeInTheDocument()
  })

  it('in a draft, offers to clean them up — one click, never on its own', () => {
    const onCleanUpNotFound = vi.fn()
    renderChips(PLACEMENTS, { onCleanUpNotFound })
    openChip()
    expect(screen.getByText('Removes these 2 placements from this view, as one change you can undo. The data is unchanged.')).toBeInTheDocument()
    expect(onCleanUpNotFound).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Clean them up' }))
    expect(onCleanUpNotFound).toHaveBeenCalledTimes(1)
  })

  it('outside a draft, offers the way into one instead', () => {
    const onOpenDraft = vi.fn()
    renderChips(PLACEMENTS, { onOpenDraft })
    openChip()
    expect(screen.queryByRole('button', { name: 'Clean them up' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open a draft to clean them up' }))
    expect(onOpenDraft).toHaveBeenCalledTimes(1)
  })

  it('to a reader who can do neither, it states the facts only', () => {
    renderChips()
    openChip()
    expect(screen.queryByRole('button', { name: /clean them up/i })).toBeNull()
  })

  it('says nothing when every placement is here', () => {
    const { container } = renderChips([])
    expect(container).toBeEmptyDOMElement()
  })
})
