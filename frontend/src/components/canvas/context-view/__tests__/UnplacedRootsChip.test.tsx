/**
 * The top-level entities a view doesn't place: a quiet chip, and a small sheet with three choices
 * — a column for each, all into one column, or not now. Nothing is added unless the reader
 * chooses; a column each past the wizard's threshold asks first, and past its ceiling is not
 * offered. Outside a draft, only the way into one, and Not now.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UnplacedRootsChip } from '../UnplacedRootsChip'

const domains = (n: number) => Array.from({ length: n }, (_, i) => ({ urn: `d${i}`, name: `Domain ${i}`, typeName: 'Domain' }))
const COLUMNS = [{ id: 'domains', name: 'Domains' }, { id: 'picked', name: 'Picked' }]

function renderChip(over: Partial<Parameters<typeof UnplacedRootsChip>[0]> = {}) {
  const props = {
    byType: [{ type: 'domain', one: 'Domain', many: 'Domains', count: 3 }],
    listed: domains(3),
    columns: COLUMNS,
    onAddAsColumns: vi.fn(),
    onAddToColumn: vi.fn(),
    onNotNow: vi.fn(),
    ...over,
  }
  render(<UnplacedRootsChip {...props} />)
  return props
}
const openSheet = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

describe('UnplacedRootsChip', () => {
  it('names their type and how many, and says what is known about them', () => {
    renderChip()
    openSheet('3 Domains aren’t in this view')
    expect(screen.getByText(
      'This source has top-level entities this view doesn’t place. They may have arrived with an ingestion, a sync or another draft’s publish — or be left out on purpose. Nothing changes unless you choose.',
    )).toBeInTheDocument()
    expect(screen.getByText('Domain 0')).toBeInTheDocument()
  })

  it('says one in the singular, several types as top-level entities, and a lower bound as one', () => {
    renderChip({ byType: [{ type: 'domain', one: 'Domain', many: 'Domains', count: 1 }], listed: domains(1) })
    expect(screen.getByRole('button', { name: '1 Domain isn’t in this view' })).toBeInTheDocument()
  })

  it('several types: top-level entities, each type counted in the sheet', () => {
    renderChip({ byType: [
      { type: 'domain', one: 'Domain', many: 'Domains', count: 3 },
      { type: 'platform', one: 'Platform', many: 'Platforms', count: 2 },
    ] })
    openSheet('5 top-level entities aren’t in this view')
    expect(screen.getByText('3 Domains · 2 Platforms')).toBeInTheDocument()
  })

  it('a count that is a lower bound says so', () => {
    renderChip({ byType: [{ type: 'domain', one: 'Domain', many: 'Domains', count: 20000 }], atLeast: true, listed: domains(200) })
    expect(screen.getByRole('button', { name: '20,000+ Domains aren’t in this view' })).toBeInTheDocument()
  })

  it('"Add each as a column" adds them at once, up to the threshold', () => {
    const props = renderChip()
    openSheet('3 Domains aren’t in this view')
    fireEvent.click(screen.getByRole('button', { name: 'Add each as a column' }))
    expect(props.onAddAsColumns).toHaveBeenCalledTimes(1)
  })

  it('past the threshold it asks first, and Back changes nothing', () => {
    const props = renderChip({ byType: [{ type: 'domain', one: 'Domain', many: 'Domains', count: 30 }], listed: domains(30) })
    openSheet('30 Domains aren’t in this view')
    fireEvent.click(screen.getByRole('button', { name: 'Add each as a column' }))
    expect(props.onAddAsColumns).not.toHaveBeenCalled()
    expect(screen.getByText('Add 30 columns?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(props.onAddAsColumns).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Add each as a column' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add 30 columns' }))
    expect(props.onAddAsColumns).toHaveBeenCalledTimes(1)
  })

  it('past the ceiling a column each is not offered, and says why', () => {
    renderChip({ byType: [{ type: 'domain', one: 'Domain', many: 'Domains', count: 250 }], listed: domains(200) })
    openSheet('250 Domains aren’t in this view')
    expect(screen.getByRole('button', { name: 'Add each as a column' })).toBeDisabled()
    expect(screen.getByText('More than 200 — too many for a column each.')).toBeInTheDocument()
    // Only the ones listed can be added to a column: said so.
    expect(screen.getByRole('button', { name: 'Add the first 200 to Domains' })).toBeInTheDocument()
  })

  it('"Add them to ‹column›" adds them to the column chosen', () => {
    const props = renderChip()
    openSheet('3 Domains aren’t in this view')
    fireEvent.change(screen.getByRole('combobox', { name: 'Column' }), { target: { value: 'picked' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add them to Picked' }))
    expect(props.onAddToColumn).toHaveBeenCalledWith('picked')
  })

  it('"Not now" hides it', () => {
    const props = renderChip()
    openSheet('3 Domains aren’t in this view')
    expect(screen.getByText('Hidden for this view until the number changes.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(props.onNotNow).toHaveBeenCalledTimes(1)
  })

  it('outside a draft: the way into one, and Not now — nothing to add from here', () => {
    const onOpenDraft = vi.fn()
    renderChip({ onAddAsColumns: undefined, onAddToColumn: undefined, columns: undefined, onOpenDraft })
    openSheet('3 Domains aren’t in this view')
    expect(screen.queryByRole('button', { name: 'Add each as a column' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Column' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open a draft to add them' }))
    expect(onOpenDraft).toHaveBeenCalledTimes(1)
  })
})
