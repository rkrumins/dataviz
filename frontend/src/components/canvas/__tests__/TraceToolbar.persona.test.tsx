/**
 * The trace bar in each view: the Business view picks a direction and exits;
 * statistics, settings, copying identifiers and exporting are the Technical
 * view's, which keeps every control it has always had.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useTraceStore } from '@/hooks/useUnifiedTrace'
import { usePersonaStore } from '@/store/persona'

import { TraceToolbar } from '../TraceToolbar'

function renderBar() {
  render(
    <TraceToolbar
      focusNodeName="Orders"
      upstreamCount={3}
      downstreamCount={5}
      showUpstream
      showDownstream
      onToggleUpstream={vi.fn()}
      onToggleDownstream={vi.fn()}
      onExitTrace={vi.fn()}
      config={useTraceStore.getState().config}
      onConfigChange={vi.fn()}
      statistics={{ upstreamCount: 3, downstreamCount: 5, totalNodes: 9, totalEdges: 8, maxUpstreamDepth: 2, maxDownstreamDepth: 3 } as never}
    />,
  )
}

describe('TraceToolbar — in each view', () => {
  it('Business: directions and Exit, nothing else', () => {
    usePersonaStore.setState({ mode: 'business' })
    renderBar()
    expect(screen.getByText(/Exit/)).toBeInTheDocument()
    expect(screen.queryByTitle('Trace statistics')).toBeNull()
    expect(screen.queryByTitle('Trace settings')).toBeNull()
    expect(screen.queryByTitle('Copy URNs')).toBeNull()
    expect(screen.queryByTitle('Export trace')).toBeNull()
  })

  it('Technical: every control, as before', () => {
    renderBar()
    expect(screen.getByTitle('Trace statistics')).toBeInTheDocument()
    expect(screen.getByTitle('Trace settings')).toBeInTheDocument()
    expect(screen.getByTitle('Copy URNs')).toBeInTheDocument()
    expect(screen.getByTitle('Export trace')).toBeInTheDocument()
  })
})
