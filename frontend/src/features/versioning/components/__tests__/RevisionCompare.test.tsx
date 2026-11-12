/**
 * RevisionCompare — what changed between two revisions: how much (added, modified, removed), over
 * how many revisions, which types it touched most (the rest folded into one row), and the changes
 * themselves; the older end always first. A revision too far back to draw says so, and offers its
 * export; the comparison goes on to the canvas highlighted on the newer end.
 */
import { render, screen, fireEvent, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangeListSummary, ChangeListTypeCount } from '@/services/versioningApiService'

const state = vi.hoisted(() => ({ origins: [] as unknown[], summary: null as unknown }))

vi.mock('../../hooks/useVersioning', () => ({
  useChangeSummary: (_ws: string, _gid: string, origin: unknown) => {
    state.origins.push(origin)
    return { data: state.summary, isLoading: false }
  },
}))
vi.mock('../ChangeList', () => ({
  ChangeList: (p: { origin: { fromSeq: number; toSeq: number } }) => <p>List of {p.origin.fromSeq}→{p.origin.toSeq}</p>,
}))
vi.mock('../RevisionPicker', () => ({
  RevisionPicker: (p: { label: string; value: number | null; onChange: (s: number | null) => void }) => (
    <button onClick={() => p.onChange(p.label === 'From' ? 30 : 5)}>{p.label}: {p.value ?? 'now'}</button>
  ),
}))

import { RevisionCompare } from '../RevisionCompare'
import { useReviewStore } from '@/store/reviewStore'

const type = (t: string, added: number, modified = 0, removed = 0): ChangeListTypeCount =>
  ({ kind: 'node', type: t, added, modified, removed })

function summary(byType: ChangeListTypeCount[]): ChangeListSummary {
  return {
    origin: { fromSeq: 10, toSeq: 40 }, counts: { added: 1200, modified: 340, removed: 12 },
    impact: {}, byType, total: 1552, listed: 1552, approximate: false,
    window: { commitCount: 30, contributors: ['u1', 'u2'], contributorCount: 2 },
  }
}

const base = {
  wsId: 'ws1', graphId: 'g1', headSeq: 40, canOpen: true,
  onBack: () => {}, onOpen: () => {}, onHighlight: () => {},
}

beforeEach(() => {
  state.origins = []
  useReviewStore.setState({ available: false, navigatorOpen: false, listOpen: false, scope: null, operation: null })
  state.summary = summary([type('Table', 800, 200, 5), type('Column', 300, 100)])
})

describe('RevisionCompare', () => {
  it('compares a revision with now: how much changed, over how many revisions, by type', () => {
    render(<RevisionCompare {...base} from={10} to={null} onChange={() => {}} />)
    expect(state.origins.at(-1)).toEqual({ fromSeq: 10, toSeq: 40 })
    expect(screen.getByText('1.2K')).toBeInTheDocument()
    expect(screen.getByText('340')).toBeInTheDocument()
    expect(screen.getByText('30')).toBeInTheDocument()
    expect(screen.getByLabelText('Table: 800 added, 200 modified, 5 removed')).toBeInTheDocument()
    expect(screen.getByText('List of 10→40')).toBeInTheDocument()
  })

  it('folds the types past the first seven into one row', () => {
    state.summary = summary(Array.from({ length: 10 }, (_, i) => type(`T${i}`, 100 - i)))
    render(<RevisionCompare {...base} from={10} to={null} onChange={() => {}} />)
    const rows = within(screen.getByRole('region', { name: 'Changed by type' })).getAllByRole('listitem')
    expect(rows).toHaveLength(8)
    expect(screen.getByText('3 other types')).toBeInTheDocument()
  })

  it('keeps the older end first, whichever end was changed', () => {
    const onChange = vi.fn()
    render(<RevisionCompare {...base} from={10} to={20} onChange={onChange} />)
    fireEvent.click(screen.getByText('From: 10'))          // picks 30, later than To
    expect(onChange).toHaveBeenLastCalledWith(20, 30)
    fireEvent.click(screen.getByText('To: 20'))            // picks 5, earlier than From
    expect(onChange).toHaveBeenLastCalledWith(5, 10)
  })

  it('says a revision too far back to draw is compared instead, and offers its export', () => {
    const onExport = vi.fn()
    render(<RevisionCompare {...base} from={10} to={null} notice="too_far" onChange={() => {}} onExport={onExport} />)
    expect(screen.getByText('Revision #10 is too far back to draw on the canvas')).toBeInTheDocument()
    expect(screen.queryByText('Open #10')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Export as it was then'))
    expect(onExport).toHaveBeenCalledWith(10)
  })

  it('highlights the comparison on the canvas', () => {
    const onHighlight = vi.fn()
    render(<RevisionCompare {...base} from={10} to={20} onChange={() => {}} onHighlight={onHighlight} />)
    fireEvent.click(screen.getByText('Highlight on canvas'))
    expect(onHighlight).toHaveBeenCalledWith(10, 20)
  })
})

describe('RevisionCompare — on the Context View', () => {
  it('reviews the changes beside the canvas, highlighted on it, in place of the list here', () => {
    useReviewStore.setState({ available: true })
    const onHighlight = vi.fn()
    render(<RevisionCompare {...base} from={10} to={30} onChange={() => {}} onHighlight={onHighlight} />)

    expect(screen.queryByText(/^List of/)).toBeNull()
    expect(screen.queryByText('Highlight on canvas')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(onHighlight).toHaveBeenCalledWith(10, 30)
    expect(useReviewStore.getState()).toMatchObject({ navigatorOpen: true, scope: null, operation: null })
  })

  it('keeps its list where nothing can be opened on the canvas', () => {
    useReviewStore.setState({ available: true })
    render(<RevisionCompare {...base} from={10} to={30} onChange={() => {}} openBlocked="Open a view first." />)
    expect(screen.getByText('List of 10→30')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Review changes' })).toBeNull()
  })
})
