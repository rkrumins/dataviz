/**
 * Ghost cues — what a portal says, and what a stub offers.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { portalLabel } from '../ghostCues'
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

describe('OffCanvasStub — lineage that leaves the view', () => {
  it('says how many, in which direction, and what a click does', () => {
    render(<OffCanvasStub side="out" count={12} partners={3} x={0} y={0} onOpen={vi.fn()} />)
    expect(screen.getByRole('button', {
      name: '12 underlying flows lead to entities outside this view. Click to see those 3 entities in the Focus Lens.',
    })).toBeInTheDocument()
  })

  it('one flow arrives, in the singular', () => {
    render(<OffCanvasStub side="in" count={1} partners={1} x={0} y={0} onOpen={vi.fn()} />)
    expect(screen.getByRole('button', {
      name: '1 underlying flow arrives from entities outside this view. Click to see that entity in the Focus Lens.',
    })).toBeInTheDocument()
  })

  it('counts entities, not flows, in what a click offers', () => {
    render(<OffCanvasStub side="out" count={900} partners={40} x={0} y={0} onOpen={vi.fn()} />)
    expect(screen.getByRole('button', {
      name: '900 underlying flows lead to entities outside this view. Click to see those 40 entities in the Focus Lens.',
    })).toBeInTheDocument()
  })

  it('wears the direction colour', () => {
    const { rerender } = render(<OffCanvasStub side="out" count={2} partners={1} x={0} y={0} />)
    expect(screen.getByRole('button').className).toContain('text-lineage-out')
    rerender(<OffCanvasStub side="in" count={2} partners={1} x={0} y={0} />)
    expect(screen.getByRole('button').className).toContain('text-lineage-in')
    expect(screen.getByRole('button').className).not.toContain('text-ink-muted')
  })

  it('opens on a click', () => {
    const onOpen = vi.fn()
    render(<OffCanvasStub side="out" count={3} partners={2} x={0} y={0} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('only states the count when there is nothing it can do', () => {
    render(<OffCanvasStub side="out" count={3} partners={2} x={0} y={0} />)
    const stub = screen.getByRole('button', { name: '3 underlying flows lead to entities outside this view' })
    expect(stub).toBeDisabled()
  })
})
