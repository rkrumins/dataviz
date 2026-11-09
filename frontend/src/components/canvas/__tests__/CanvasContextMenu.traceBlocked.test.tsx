/**
 * Where the canvas can't trace (a past revision, whose rolled-up trace reads the graph as it is
 * now), the entity menu keeps Trace Lineage, disabled, and says why on it.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { OFF_AT_REVISION } from '@/features/versioning/model/revisionCopy'

import { CanvasContextMenu } from '../CanvasContextMenu'

function renderMenu(traceBlocked?: string) {
  const onTraceNode = vi.fn()
  render(
    <CanvasContextMenu
      isOpen
      position={{ x: 10, y: 10 }}
      target={{ type: 'node', id: 'orders' }}
      onClose={vi.fn()}
      onTraceNode={onTraceNode}
      traceBlocked={traceBlocked}
    />,
  )
  return { onTraceNode, trace: screen.getByRole('button', { name: /Trace Lineage/ }) }
}

describe('CanvasContextMenu — Trace Lineage where the canvas can’t trace', () => {
  it('is kept, disabled, and says why', () => {
    const { onTraceNode, trace } = renderMenu(OFF_AT_REVISION)
    expect(trace).toBeDisabled()
    expect(trace).toHaveAttribute('title', OFF_AT_REVISION)
    fireEvent.click(trace)
    expect(onTraceNode).not.toHaveBeenCalled()
  })

  it('traces where it can', () => {
    const { onTraceNode, trace } = renderMenu()
    expect(trace).toBeEnabled()
    expect(trace).not.toHaveAttribute('title')
    fireEvent.click(trace)
    expect(onTraceNode).toHaveBeenCalledWith('orders')
  })
})
