/**
 * SelectionBar — says what is held, and what will happen to it.
 *
 * The count alone cannot be corrected, so the entities are named and each
 * one can be taken out. And where the Focus Lens cannot take a
 * multi-selection the bar SAYS so, rather than leaving a dead button and the
 * question it always raises.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { SelectionBar } from '../SelectionBar'

const labelFor = (id: string) => ({ a: 'orders', b: 'customers', c: 'returns' }[id] ?? id)

function renderBar(nodeIds: string[], over: Partial<Parameters<typeof SelectionBar>[0]> = {}) {
  const props = {
    nodeIds,
    labelFor,
    onRemove: vi.fn(),
    onClear: vi.fn(),
    onTrace: vi.fn(),
    ...over,
  }
  render(<SelectionBar {...props} />)
  return props
}

describe('SelectionBar', () => {
  it('stays out of the way when nothing is selected', () => {
    renderBar([])
    expect(screen.queryByRole('region', { name: /selected entities/i })).not.toBeInTheDocument()
  })

  it('stays out of the way for ONE entity, which the header and drawer already serve', () => {
    renderBar(['a'])
    expect(screen.queryByRole('region', { name: /selected entities/i })).not.toBeInTheDocument()
  })

  it('names what is held, so it can be checked', () => {
    renderBar(['a', 'b'])
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('orders')).toBeInTheDocument()
    expect(screen.getByText('customers')).toBeInTheDocument()
  })

  it('says how many it did not name', () => {
    renderBar(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(screen.getByText('6')).toBeInTheDocument()
    expect(screen.getByText(/and 2 more/i)).toBeInTheDocument()
  })

  it('takes one entity back out', async () => {
    const user = userEvent.setup()
    const { onRemove } = renderBar(['a', 'b'])

    await user.click(screen.getByRole('button', { name: /remove orders/i }))
    expect(onRemove).toHaveBeenCalledWith('a')
  })

  it('says what Trace will do with all of them', async () => {
    const user = userEvent.setup()
    const { onTrace } = renderBar(['a', 'b', 'c'])

    const trace = screen.getByRole('button', { name: /trace all 3/i })
    await user.click(trace)
    expect(onTrace).toHaveBeenCalled()
  })



  it('explains the Lens instead of leaving a dead button', () => {
    renderBar(['a', 'b'])
    expect(screen.queryByRole('button', { name: /^focus$/i })).not.toBeInTheDocument()
    expect(screen.getByText(/focus lens takes one entity/i)).toBeInTheDocument()
  })

  it('clears the whole selection', async () => {
    const user = userEvent.setup()
    const { onClear } = renderBar(['a', 'b'])

    await user.click(screen.getByRole('button', { name: /clear/i }))
    expect(onClear).toHaveBeenCalled()
  })
})
