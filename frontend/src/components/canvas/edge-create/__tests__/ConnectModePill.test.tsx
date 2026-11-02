/**
 * ConnectModePill — always says what the connection is waiting for, and offers
 * the way forward (Link N) and the way out (Cancel, Done) for that moment.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConnectModePill, type ConnectModePillProps } from '../ConnectModePill'

function renderPill(over: Partial<ConnectModePillProps> = {}) {
  const props: ConnectModePillProps = {
    phase: 'armed',
    sourceLabel: 'orders',
    sourceCount: 1,
    targetCount: 0,
    nudge: 0,
    tool: false,
    onLinkTargets: vi.fn(),
    onClearTargets: vi.fn(),
    onCancel: vi.fn(),
    onExitTool: vi.fn(),
    onSearchTarget: vi.fn(),
    ...over,
  }
  render(<ConnectModePill {...props} />)
  return props
}

describe('ConnectModePill', () => {
  it('armed from one entity: names it, and offers Find… and Cancel', () => {
    const props = renderPill()
    expect(screen.getByText(/Connecting from/)).toHaveTextContent('Connecting from orders')
    fireEvent.click(screen.getByRole('button', { name: 'Find the target in a list' }))
    expect(props.onSearchTarget).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(props.onCancel).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Done connecting' })).toBeNull()
  })

  it('with targets picked: Link N and Clear', () => {
    const props = renderPill({ targetCount: 3 })
    expect(screen.getByText(/3 targets picked/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Link 3/ }))
    expect(props.onLinkTargets).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(props.onClearTargets).toHaveBeenCalled()
  })

  it('carrying a selection: counts it, and offers no list search', () => {
    renderPill({ sourceCount: 4, sourceLabel: null })
    expect(screen.getByText(/Connecting/)).toHaveTextContent('Connecting 4 entities')
    expect(screen.queryByRole('button', { name: 'Find the target in a list' })).toBeNull()
  })

  it('the tool waiting for a source: says so, and Done turns it off', () => {
    const props = renderPill({ phase: 'tool', tool: true, sourceLabel: null, sourceCount: 0 })
    expect(screen.getByText(/click the entity a link starts from/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Done connecting' }))
    expect(props.onExitTool).toHaveBeenCalled()
  })

  it('is marked as connect chrome, so its own clicks never nudge', () => {
    renderPill()
    expect(screen.getByRole('status')).toHaveAttribute('data-connect-ui')
  })
})
