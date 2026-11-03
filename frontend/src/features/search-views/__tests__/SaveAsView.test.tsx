/**
 * Save as view — one sheet, whatever is kept. A search's matches are kept live; a
 * narrowing live where a live view can keep what it reaches, else as a list of its
 * members, with a switch where both are possible and the reason where they aren't.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../SaveSearchAsViewSheet', () => ({
  SaveSearchAsViewSheet: (p: { initialInclude?: unknown; initialWithin?: string; headerExtra?: React.ReactNode; onNarrowInstead?: () => void }) => (
    <div>
      <p>live sheet</p>
      <p data-testid="include">{JSON.stringify(p.initialInclude ?? null)}</p>
      {p.onNarrowInstead && <button type="button" onClick={p.onNarrowInstead}>narrow instead</button>}
      {p.headerExtra}
    </div>
  ),
}))
vi.mock('@/features/live-views/SaveAsViewSheet', () => ({
  SaveAsViewSheet: (p: { headerExtra?: React.ReactNode }) => <div><p>list sheet</p>{p.headerExtra}</div>,
}))

import { SaveAsView, type SaveAsViewProps } from '../SaveAsView'

const P = { kind: 'tag', values: ['pii'] } as never
const narrowing = (expand: Record<string, unknown>, seeds: Record<string, unknown> = { query: P }) => ({
  kind: 'narrowing' as const,
  draft: { spec: { v: 1, seeds, within: 'view', expand: { children: 0, upstream: 0, downstream: 0, partnerChildren: 0, ...expand } }, seedsLabel: 'x' } as never,
})

function renderIt(over: Partial<SaveAsViewProps>) {
  const props: SaveAsViewProps = {
    source: { kind: 'search', predicate: P }, viewId: 'v', viewName: 'Sales', workspaceId: 'ws',
    boardLayers: [], canKeepLive: true, canKeepList: true, onClose: vi.fn(), onSaved: vi.fn(), ...over,
  }
  return render(<SaveAsView {...props} />)
}

describe('SaveAsView', () => {
  it('keeps a search’s matches live, with a way to narrow first for more reach', () => {
    const onNarrowInstead = vi.fn()
    renderIt({ onNarrowInstead })
    expect(screen.getByText('live sheet')).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Keep it' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'narrow instead' }))
    expect(onNarrowInstead).toHaveBeenCalled()
  })

  it('keeps a narrowing live when a live view can keep what it reaches, and can switch to a list', () => {
    renderIt({ source: narrowing({ children: 'all', downstream: 1 }) })
    expect(screen.getByText('live sheet')).toBeInTheDocument()
    expect(screen.getByTestId('include').textContent).toBe(JSON.stringify(
      { contents: true, containers: false, upstream: false, downstream: true }))
    fireEvent.click(screen.getByRole('radio', { name: /As a list/ }))
    expect(screen.getByText('list sheet')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /Live/ }))
    expect(screen.getByText('live sheet')).toBeInTheDocument()
  })

  it.each([
    ['chosen entities', narrowing({}, { urns: ['u'] }), /chosen entities/],
    ['two steps of lineage', narrowing({ upstream: 2 }), /more than one step/],
  ])('keeps a narrowing of %s as a list, saying why it can’t be live', (_what, source, why) => {
    renderIt({ source })
    expect(screen.getByText('list sheet')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Live/ })).toBeDisabled()
    expect(screen.getByText(why)).toBeInTheDocument()
  })

  it('with live views off, a narrowing is a list', () => {
    renderIt({ source: narrowing({}), canKeepLive: false })
    expect(screen.getByText('list sheet')).toBeInTheDocument()
    expect(screen.getByText(/Live views are turned off here/)).toBeInTheDocument()
  })
})
