/**
 * THE NOTICE STRIP, MADE HONEST about the native walk (D3, 2026-08-21).
 *
 * On the native engine there is no budget and no depth to reduce: a walk
 * that stopped either parked at the one-time memory checkpoint or lost a
 * step at the data source. The strip used to file both as "Trace truncated
 * — Reduce depth", and Reduce depth is pure view scoping on this engine —
 * it REMOVES participants instead of fetching them. In `nativeMode` the
 * strip says what happened and offers the one thing that helps.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TraceDockNoticeStrip } from '../TraceDockNoticeStrip'
import type { TraceResult } from '@/hooks/useUnifiedTrace'

const result = (over: Partial<TraceResult>): TraceResult => ({
  focusId: 'f',
  traceNodes: new Set(['f']),
  upstreamNodes: new Set(),
  downstreamNodes: new Set(),
  traceEdges: new Set(),
  lineageResult: null,
  ...over,
})

const manyNodes = (n: number) => new Set(Array.from({ length: n }, (_, i) => `n${i}`))

function renderStrip(r: TraceResult, nativeMode: boolean) {
  const onReduceDepth = vi.fn()
  const onContinue = vi.fn()
  render(
    <TraceDockNoticeStrip
      result={r}
      displayMap={new Map()}
      onReduceDepth={onReduceDepth}
      onJumpToUrn={vi.fn()}
      nativeMode={nativeMode}
      onContinue={onContinue}
    />,
  )
  return { onReduceDepth, onContinue }
}

describe('TraceDockNoticeStrip — nativeMode', () => {
  it('the memory checkpoint: says how large the flow is and offers Continue', () => {
    const { onContinue, onReduceDepth } = renderStrip(result({ truncated: true, truncationReason: 'checkpoint', traceNodes: manyNodes(50_000) }), true)
    // The number sits in its own span, so read the strip's whole sentence.
    expect(document.body.textContent).toMatch(/larger than 50,000 nodes/i)
    expect(screen.queryByRole('button', { name: /reduce depth/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    expect(onContinue).toHaveBeenCalledTimes(1)
    expect(onReduceDepth).not.toHaveBeenCalled()
  })

  it('a failed step: says part of the lineage could not be loaded and offers Try again — no reason token', () => {
    const { onContinue } = renderStrip(result({ truncated: true, truncationReason: 'timeout', traceNodes: manyNodes(12) }), true)
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument()
    expect(document.body.textContent).toMatch(/12 nodes are on the board/i)
    expect(document.body.textContent).not.toMatch(/timeout|max_nodes|truncated/i)
    expect(screen.queryByRole('button', { name: /reduce depth/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('a complete walk says nothing', () => {
    renderStrip(result({ truncated: false, traceNodes: manyNodes(3000) }), true)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('legacy mode is untouched: a size-cap truncation still offers Reduce depth', () => {
    const { onReduceDepth } = renderStrip(result({ truncated: true, truncationReason: 'max_nodes', traceNodes: manyNodes(2000) }), false)
    fireEvent.click(screen.getByRole('button', { name: /reduce depth/i }))
    expect(onReduceDepth).toHaveBeenCalledTimes(1)
  })
})
