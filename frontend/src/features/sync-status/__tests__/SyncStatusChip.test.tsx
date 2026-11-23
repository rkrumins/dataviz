/**
 * SyncStatusChip in each view. The Business view keeps its plain pill (Up to date, Updating, May
 * be out of date) and opens a card in plain words: the kind of graph, the commit saved, what views
 * show and the summaries, with the store names only behind "Show technical details". The Technical
 * view keeps the button and the card behind it. The status hook is mocked.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePreferencesStore } from '@/store/preferences'
import type { SyncStatus } from '../syncStatusApi'

let data: SyncStatus | undefined

vi.mock('../useSyncStatus', () => ({
  useSyncStatus: () => ({ data, isError: false, isFetching: false, refetch: vi.fn() }),
}))

import { SyncStatusChip } from '../SyncStatusChip'
import { usePersonaStore } from '@/store/persona'

/** Relative, so "checked 2m ago" never depends on today's date. */
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

function versioned(over: Partial<NonNullable<SyncStatus['versioned']>> = {}): SyncStatus {
  const at = minutesAgo(2)
  const rev = { commitId: 'cmt_01M3AH4A26Y5ZFJ60G1ZYNM07A', createdAt: at, actorName: 'System Admin', message: 'Publish draft' }
  return {
    kind: 'versioned', dataSourceId: 'ds', checkedAt: at,
    versioned: { graphId: 'g', committed: 11, projected: 11, fresh: true, status: 'idle', committedRevision: rev, projectedRevision: rev, lastProjectedAt: at, ...over },
    summaries: { aggregationStatus: 'ready', driftState: 'managed', lastJobStatus: 'completed', lastSuccessAt: at },
    counts: { nodes: 1922, edges: 2288, readAt: at },
  }
}

const renderChip = () => render(<SyncStatusChip workspaceId="ws1" dataSourceId="ds" viewId="v1" />)

beforeEach(() => {
  data = versioned()
})

describe('SyncStatusChip in the Business view', () => {
  beforeEach(() => {
    usePersonaStore.setState({ mode: 'business' })
    usePreferencesStore.setState({ syncTechnicalDetailsOpen: false })
  })

  it('says it is up to date and when that was checked, as a button naming no store', () => {
    renderChip()
    const chip = screen.getByRole('button', { name: /^Sync status: Versioned graph, Everything is in sync/ })
    expect(chip).toHaveTextContent('Up to date · checked 2m ago')
    for (const word of ['Postgres', 'FalkorDB', 'cmt_', 'v11']) {
      expect(document.body.textContent).not.toContain(word)
    }
  })

  it('opens a card in plain words: the kind of graph, the commit saved and what views show', async () => {
    renderChip()
    await userEvent.setup().click(screen.getByRole('button', { name: /^Sync status/ }))
    const card = await screen.findByRole('dialog', { name: 'Sync details' })
    // The card takes focus, not Check again — whose tip would otherwise open with it.
    expect(card).toHaveFocus()
    expect(within(card).getByText('Versioned graph')).toBeInTheDocument()
    expect(within(card).getByText('Every change is saved as a version')).toBeInTheDocument()
    const lanes = within(card).getByRole('list', { name: 'How up to date this view is' })
    for (const title of ['Saved version', 'What you see', 'Summaries']) expect(within(lanes).getByText(title)).toBeInTheDocument()
    expect(within(lanes).getByText('Version 11 · the latest')).toBeInTheDocument()
    expect(within(lanes).getByRole('button', { name: 'Copy commit cmt_01M3AH4A26Y5ZFJ60G1ZYNM07A' })).toHaveTextContent('cmt_01M3AH4A…')
    expect(within(lanes).getByText('Same commit as the saved version')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Check again' })).toBeInTheDocument()
    for (const word of ['Postgres', 'FalkorDB', 'system of record']) expect(card.textContent).not.toContain(word)
  })

  it('shows the full commit id on hover', async () => {
    renderChip()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^Sync status/ }))
    await user.hover(await screen.findByRole('button', { name: /^Copy commit/ }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('cmt_01M3AH4A26Y5ZFJ60G1ZYNM07A')
  })

  it('keeps the store names behind "Show technical details", and remembers it open', async () => {
    const user = userEvent.setup()
    const { unmount } = renderChip()
    await user.click(screen.getByRole('button', { name: /^Sync status/ }))
    const toggle = await screen.findByRole('button', { name: 'Show technical details' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Postgres')).toBeNull()
    await user.click(toggle)
    expect(screen.getByRole('button', { name: 'Hide technical details' })).toHaveAttribute('aria-expanded', 'true')
    const technical = screen.getByRole('list', { name: "Where this view's data comes from" })
    expect(within(technical).getByText('Postgres')).toBeInTheDocument()
    expect(within(technical).getByText('FalkorDB')).toBeInTheDocument()
    expect(usePreferencesStore.getState().syncTechnicalDetailsOpen).toBe(true)
    unmount()
    renderChip()
    await user.click(screen.getByRole('button', { name: /^Sync status/ }))
    expect(await screen.findByText('Postgres')).toBeInTheDocument()
  })

  it('says an external graph is read live from its source, with no commit', async () => {
    data = {
      kind: 'external', dataSourceId: 'ds', checkedAt: minutesAgo(2),
      source: { changedSinceRefresh: false, lastReconciledAt: minutesAgo(30) },
      summaries: { aggregationStatus: 'ready', driftState: 'inSync', autoRefresh: true, lastJobStatus: 'completed', lastSuccessAt: minutesAgo(30) },
      counts: { nodes: 5, edges: 4, readAt: minutesAgo(2) },
    }
    renderChip()
    await userEvent.setup().click(screen.getByRole('button', { name: /^Sync status: External graph/ }))
    const card = await screen.findByRole('dialog', { name: 'Sync details' })
    expect(within(card).getByText('External graph')).toBeInTheDocument()
    expect(within(card).getByText('Read live from its source — never changed here')).toBeInTheDocument()
    expect(within(card).getByText('Source')).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: /^Copy commit/ })).toBeNull()
    expect(within(card).queryByRole('button', { name: 'Open Data health' })).toBeNull()
    expect(card.textContent).not.toContain('FalkorDB')
  })

  it('says it is updating while the graph catches up', () => {
    data = versioned({ projected: 9, fresh: false, status: 'projecting' })
    renderChip()
    expect(screen.getByText('Updating…')).toBeInTheDocument()
  })

  it('says an earlier version is showing while the newer one is written, and which on hover', async () => {
    data = versioned({ projected: 9, fresh: false, status: 'projecting', served: 9 })
    renderChip()
    await userEvent.setup().hover(screen.getByText('Showing an earlier version · updating…'))
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Showing an earlier version while the graph updates')
    expect(tip).toHaveTextContent('Views show version #9')
    expect(tip).toHaveTextContent('until version #11 is written to the graph, then refresh on their own')
    for (const word of ['Postgres', 'FalkorDB', 'cmt_']) {
      expect(document.body.textContent).not.toContain(word)
    }
  })

  it('says it may be out of date when the graph is behind', () => {
    data = versioned({ projected: 10, fresh: false })
    renderChip()
    expect(screen.getByText('May be out of date')).toBeInTheDocument()
  })

  it('says the same when the graph failed to refresh', () => {
    data = versioned({ projected: 10, fresh: false, lastError: 'boom' })
    renderChip()
    expect(screen.getByText('May be out of date')).toBeInTheDocument()
  })

  it('says it is checking until a status arrives', () => {
    data = undefined
    renderChip()
    expect(screen.getByText('Checking sync…')).toBeInTheDocument()
  })
})

describe('SyncStatusChip in the Technical view', () => {
  it('says which earlier version views show and which is being written', () => {
    data = versioned({ projected: 9, fresh: false, status: 'projecting', served: 9 })
    renderChip()
    const chip = screen.getByRole('button', { name: /^Sync status/ })
    expect(chip).toHaveTextContent('Showing #9 · writing #11')
    fireEvent.click(chip)
    expect(screen.getByText('Showing an earlier version while the graph updates')).toBeInTheDocument()
    expect(screen.getByText('Views show version #9 until version #11 is written, then refresh on their own')).toBeInTheDocument()
  })

  it('is a button saying the version, opening the card that names the stores', () => {
    renderChip()
    const chip = screen.getByRole('button', { name: /^Sync status/ })
    expect(chip).toHaveTextContent('In sync · v11')
    fireEvent.click(chip)
    expect(screen.getByText('Postgres')).toBeInTheDocument()
    expect(screen.getByText('FalkorDB')).toBeInTheDocument()
  })
})
