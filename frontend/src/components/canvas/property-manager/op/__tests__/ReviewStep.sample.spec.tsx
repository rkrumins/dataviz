/**
 * ReviewStep — Sample: a few of the entities the change reaches, read on the draft by the server,
 * each as it is now and as the job would leave it — changed, unchanged, or skipped and why. A rename
 * shows both names. While it is read the table's shape stands in; one that couldn't be read offers
 * to try again, and one that reaches nothing offers another target.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { PropertyJobPreview, PropertyJobSample } from '@/services/versioningApiService'
import type { OpDraft } from '../opModel'
import { ReviewStep } from '../ReviewStep'

const SET: OpDraft = { kind: 'set', key: 'owner', to: '', value: 'ana', onConflict: 'skip' }
const RENAME: OpDraft = { kind: 'rename', key: 'owner', to: 'steward', value: '', onConflict: 'skip' }

function review(op: OpDraft, { sample = null as PropertyJobSample | null, sampleLoading = false, sampleError = null as string | null,
  preview = null as PropertyJobPreview | null, edges = false } = {}) {
  const onRetrySample = vi.fn()
  const onChangeTarget = vi.fn()
  render(
    <ReviewStep op={op} preset={{ kind: 'view' }} scopeMode="view" counts={null} impact={{ changes: 2, replaced: 1, untouched: 1 }} exact
      preview={preview} previewLoading={false} sample={sample} sampleLoading={sampleLoading} sampleError={sampleError}
      onRetrySample={onRetrySample} onChangeTarget={onChangeTarget} stagedCount={0} edges={edges} offerSave={false} />,
  )
  return { onRetrySample, onChangeTarget }
}
const region = () => within(screen.getByRole('region', { name: 'Sample' }))
/** Each row of the table, cell by cell. */
const rows = () => within(screen.getByRole('table')).getAllByRole('row').map((r) => within(r).queryAllByRole('cell').map((c) => c.textContent))

describe('ReviewStep — sample', () => {
  it('shows each entity now and after, with what the job does to it', () => {
    review(SET, { sample: { truncated: true, rows: [
      { id: 'N1', urn: 'urn:n1', name: 'orders', type: 'Table', before: 'bo', after: 'ana', outcome: 'change' },
      { id: 'N2', urn: 'urn:n2', name: 'customers', type: 'Table', before: 'ana', after: 'ana', outcome: 'unchanged' },
      { id: 'N3', urn: 'urn:n3', name: 'refunds', type: 'View', outcome: 'change', after: 'ana' },
      { id: 'N4', urn: 'urn:n4', name: 'returns', type: 'Table', before: 'cy', after: 'cy', outcome: 'skip', reason: 'no_longer_matches' },
      { id: 'urn:gone', name: 'urn:gone', type: null, outcome: 'skip', reason: 'missing' },
    ] } })
    expect(screen.getByRole('table', { name: /before and after/ })).toBeInTheDocument()
    expect(within(screen.getByRole('table')).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Entity', 'Now', 'After', 'What it does'])
    expect(rows().slice(1)).toEqual([
      ['ordersTable', '“bo”', '“ana”', 'Changes'],
      ['customersTable', '“ana”', '“ana”', 'No change'],
      ['refundsView', 'not set', '“ana”', 'Changes'],
      ['returnsTable', '“cy”', '“cy”', 'SkippedYour draft changed it out of the search'],
      ['urn:gone', '—', '—', 'SkippedNot in this draft'],
    ])
    expect(region().getByText('A few of them — there are more.')).toBeInTheDocument()
  })

  it('a rename names both keys, shows what the new one holds already, and says why it skips one', () => {
    review(RENAME, { sample: { truncated: false, rows: [
      { id: 'N1', name: 'orders', type: 'Table', before: 'ana', after: 'ana', outcome: 'change' },
      { id: 'N2', name: 'customers', type: 'Table', before: 'ana', to: 'bo', after: 'bo', outcome: 'skip', reason: 'conflict' },
    ] } })
    expect(within(screen.getByRole('table')).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Entity', 'Now owner', 'After steward', 'What it does'])
    expect(rows().slice(1)).toEqual([
      ['ordersTable', '“ana”', '“ana”', 'Changes'],
      ['customersTable', '“ana”steward“bo”', '“bo”', 'SkippedAlready has steward'],
    ])
    expect(region().queryByText(/there are more/)).toBeNull()
  })

  it('a removal says the value is removed; a relationship is named by its ends', () => {
    review({ ...SET, kind: 'remove' }, { edges: true, sample: { truncated: false, rows: [
      { id: 'E1', name: 'orders → customers', type: 'FLOWS_TO', before: 'bo', outcome: 'change' },
      { id: 'R1', name: 'orders → refunds', type: 'AGGREGATED', before: 'cy', after: 'cy', outcome: 'skip', reason: 'derived' },
    ] } })
    expect(screen.getByRole('table', { name: /Some of the relationships it reaches/ })).toBeInTheDocument()
    expect(rows().slice(1)).toEqual([
      ['orders → customersFLOWS_TO', '“bo”', 'removed', 'Changes'],
      ['orders → refundsAGGREGATED', '“cy”', '“cy”', 'SkippedA roll-up, never changed'],
    ])
  })

  it('while it is read, the table’s shape stands in', () => {
    review(SET, { sampleLoading: true })
    expect(screen.getByRole('region', { name: 'Sample' })).toHaveAttribute('aria-busy', 'true')
    expect(region().getByText('Reading a few of them from your draft…')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('one that couldn’t be read offers to try again', async () => {
    const user = userEvent.setup()
    const { onRetrySample } = review(SET, { sampleError: 'The server is busy' })
    expect(region().getByText('The server is busy — the change can be applied all the same.')).toBeInTheDocument()
    await user.click(region().getByRole('button', { name: 'Try again' }))
    expect(onRetrySample).toHaveBeenCalled()
  })

  it('says nothing more when the check refuses the change for the same reason', () => {
    review(SET, { sampleError: 'The view isn’t there.', preview: {
      refusal: { code: 'view_not_found', message: 'The view isn’t there.' }, nameBudget: null, activeJobId: null, counts: null } })
    expect(screen.queryByRole('region', { name: 'Sample' })).toBeNull()
    expect(screen.getAllByText('The view isn’t there.')).toHaveLength(1)
  })

  it('one that reaches nothing offers another target', async () => {
    const user = userEvent.setup()
    const { onChangeTarget } = review(SET, { sample: { rows: [], truncated: false } })
    expect(region().getByText('No entities to show')).toBeInTheDocument()
    await user.click(region().getByRole('button', { name: 'Choose another target' }))
    expect(onChangeTarget).toHaveBeenCalled()
  })
})
