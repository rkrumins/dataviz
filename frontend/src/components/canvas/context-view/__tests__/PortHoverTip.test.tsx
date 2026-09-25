/**
 * What a lineage port says on hover.
 *
 * A card whose lineage could not be counted says exactly that, and that the
 * canvas is asking again — never that data is "not loaded".
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { describe, expect, it } from 'vitest'

import { PortHoverTip } from '../PortHoverTip'

function Scroller({ port }: { port: Record<string, string> }) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref}>
      <span data-testid="port" {...port} />
      <PortHoverTip scrollerRef={ref} />
    </div>
  )
}

describe('PortHoverTip', () => {
  it('a port whose count failed says it could not be counted and is being retried', () => {
    render(<Scroller port={{ 'data-lineage-port': 'left', 'data-port': 'unknown', 'data-dir': 'both' }} />)
    fireEvent.pointerOver(screen.getByTestId('port'))
    const tip = screen.getByRole('tooltip')
    expect(tip.textContent).toContain('Lineage for this entity could not be counted — retrying')
    expect(tip.textContent).not.toMatch(/load/i)
  })

  it('a solid port still counts its lines', () => {
    render(<Scroller port={{ 'data-lineage-port': 'right', 'data-port': 'here', 'data-dir': 'out', 'data-out': '3' }} />)
    fireEvent.pointerOver(screen.getByTestId('port'))
    expect(screen.getByRole('tooltip').textContent).toContain('3 lines go out here')
  })
})
