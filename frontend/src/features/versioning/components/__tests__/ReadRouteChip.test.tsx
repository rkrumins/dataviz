/**
 * ReadRouteChip — says which store the canvas is reading from, from the watermark's `readRoute`
 * (the server's own routing rule). Published on FalkorDB is the steady state and says nothing, so
 * the bar can stay empty on main; Postgres while the projection catches up, and every draft
 * (always an overlay on whatever serves main), do. The Business view names no store: it says
 * nothing while FalkorDB serves published, draft or not, and only that reads may be slower while
 * Postgres stands in. The watermark hook is mocked.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Watermark } from '@/services/versioningApiService'
import { usePersonaStore } from '@/store/persona'

let wm: Watermark | undefined

vi.mock('../../hooks/useVersioning', () => ({
  useProjectionWatermark: () => ({ data: wm }),
}))

import { ReadRouteChip } from '../ReadRouteChip'

const WM: Watermark = {
  committed: 12, projected: 12, fresh: true, status: 'idle',
  providerId: 'prov_1', providerName: 'Falkor West',
  readRoute: { main: 'falkordb', drafts: 'overlay' },
}

beforeEach(() => {
  wm = { ...WM }
})

describe('ReadRouteChip', () => {
  it('says nothing on published while FalkorDB serves it', () => {
    const { container } = render(<ReadRouteChip workspaceId="ws1" graphId="g1" isDraft={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says published is served from Postgres while the projection catches up', () => {
    wm = { ...WM, projected: 10, fresh: false, readRoute: { main: 'postgres', drafts: 'overlay' } }
    render(<ReadRouteChip workspaceId="ws1" graphId="g1" isDraft={false} />)
    expect(screen.getByText('Serving from Postgres (catching up)')).toBeInTheDocument()
  })

  it('says an unloaded graph is served from Postgres, not that it is catching up', () => {
    wm = { ...WM, projected: 0, fresh: false, status: 'evicted', readRoute: { main: 'postgres', drafts: 'overlay' } }
    render(<ReadRouteChip workspaceId="ws1" graphId="g1" isDraft={false} />)
    expect(screen.getByText('Serving from Postgres (unloaded)')).toBeInTheDocument()
  })

  it('says a failed pass waiting for its retry is retrying, not catching up', () => {
    wm = { ...WM, projected: 10, fresh: false, lastError: 'timeout', readRoute: { main: 'postgres', drafts: 'overlay' } }
    render(<ReadRouteChip workspaceId="ws1" graphId="g1" isDraft={false} />)
    expect(screen.getByText('Serving from Postgres (retrying)')).toBeInTheDocument()
  })

  it('says a fork too far from its parent to overlay is served from Postgres, and why', () => {
    wm = {
      ...WM, providerId: null, providerName: null, readsThrough: 'g_root', readsFrom: 'postgres',
      readRoute: { main: 'postgres', drafts: 'overlay' },
    }
    render(<ReadRouteChip workspaceId="ws1" graphId="g_fork" isDraft={false} />)
    expect(screen.getByText('Serving from Postgres (far from its parent)')).toBeInTheDocument()
  })

  it('names the FalkorDB provider under a draft overlay', () => {
    render(<ReadRouteChip workspaceId="ws1" graphId="g1" isDraft />)
    expect(screen.getByText('Serving from FalkorDB · Falkor West · draft overlay')).toBeInTheDocument()
  })

  it('names the default graph store when the graph has no provider pinned', () => {
    wm = { ...WM, providerId: null, providerName: null }
    render(<ReadRouteChip workspaceId="ws1" graphId="g1" isDraft />)
    expect(screen.getByText('Serving from FalkorDB · Default graph store · draft overlay')).toBeInTheDocument()
  })

  it('overlays a draft on Postgres while published catches up', () => {
    wm = { ...WM, projected: 10, fresh: false, readRoute: { main: 'postgres', drafts: 'overlay' } }
    render(<ReadRouteChip workspaceId="ws1" graphId="g1" isDraft />)
    expect(screen.getByText('Serving from Postgres (catching up) · draft overlay')).toBeInTheDocument()
  })

  it('renders nothing before the watermark arrives or from a server without readRoute', () => {
    wm = undefined
    const { container, rerender } = render(<ReadRouteChip workspaceId="ws1" graphId="g1" isDraft />)
    expect(container).toBeEmptyDOMElement()
    wm = { ...WM, readRoute: undefined }
    rerender(<ReadRouteChip workspaceId="ws1" graphId="g1" isDraft />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('ReadRouteChip in the Business view', () => {
  beforeEach(() => usePersonaStore.setState({ mode: 'business' }))

  it('says only that reads may be slower while Postgres catches up, naming no store', async () => {
    wm = { ...WM, projected: 10, fresh: false, readRoute: { main: 'postgres', drafts: 'overlay' } }
    render(<ReadRouteChip workspaceId="ws1" graphId="g1" isDraft={false} />)
    const chip = screen.getByText('Catching up — may be slower')
    await userEvent.setup().hover(chip)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Reads stay correct while it catches up')
    expect(document.body.textContent).not.toMatch(/Postgres|FalkorDB/)
  })

  it('says nothing under a draft while FalkorDB serves published', () => {
    const { container } = render(<ReadRouteChip workspaceId="ws1" graphId="g1" isDraft />)
    expect(container).toBeEmptyDOMElement()
  })
})
