/**
 * Ghost cues — what a portal says, and what a stub offers.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { BRING_IN_BATCH, portalLabel } from '../ghostCues'
import { OffCanvasStub } from '../OffCanvasStub'

describe('portalLabel — where lineage out of sight goes, named', () => {
  it('names the one entity and its layer', () => {
    expect(portalLabel(['Tableau'], 1, ['Report'])).toBe('Tableau · Report')
  })

  it('says how many, and where, when there are several', () => {
    expect(portalLabel(['a', 'b', 'c'], 3, ['Report'])).toBe('3 in Report')
    expect(portalLabel(['a', 'b'], 5, ['Report', 'Mart'])).toBe('5 in 2 layers')
  })

  it('falls back to the name, or the count, when the layer is unknown', () => {
    expect(portalLabel(['Tableau'], 1, [])).toBe('Tableau')
    expect(portalLabel(['a', 'b'], 2, [])).toBe('2 entities')
  })
})

describe('OffCanvasStub — lineage whose far end is not on the canvas', () => {
  it('says how many, in which direction, and what a click does', () => {
    render(<OffCanvasStub side="out" count={12} x={0} y={0} onBringIn={vi.fn()} />)
    expect(screen.getByRole('button', {
      name: '12 underlying flows lead to entities that are not on the canvas. Click to bring them in.',
    })).toBeInTheDocument()
  })

  it('offers a first batch when there are more than one click brings in', () => {
    render(<OffCanvasStub side="in" count={BRING_IN_BATCH + 73} x={0} y={0} onBringIn={vi.fn()} />)
    expect(screen.getByRole('button', {
      name: `${(BRING_IN_BATCH + 73).toLocaleString()} underlying flows arrive from entities that are not on the canvas. Click to bring the first ${BRING_IN_BATCH} in.`,
    })).toBeInTheDocument()
  })

  it('brings them in on a click', () => {
    const onBringIn = vi.fn()
    render(<OffCanvasStub side="out" count={3} x={0} y={0} onBringIn={onBringIn} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onBringIn).toHaveBeenCalledTimes(1)
  })

  it('only states the count when there is nothing it can do', () => {
    render(<OffCanvasStub side="out" count={3} x={0} y={0} />)
    const stub = screen.getByRole('button', { name: '3 underlying flows lead to entities that are not on the canvas' })
    expect(stub).toBeDisabled()
  })
})
