/**
 * What a draft changed, property by property, told against what is published: each change says
 * whether it is saved in the draft or only staged; read-only, the changes still show (with what each
 * was); "Changes only" narrows to them; Restore puts a property back as published.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PropertyEditor } from '../../PropertyEditor'
import { propertyMarks } from '../changeMarks'

const published = { owner: 'ana', tier: 'silver', legacy: true, sla: '1h' }
// Saved in the draft: owner edited, legacy removed, steward added. Staged since: tier edited, sla removed.
const original = { owner: 'bea', tier: 'silver', sla: '1h', steward: 'cy' }
const value = { owner: 'bea', tier: 'gold', steward: 'cy' }

describe('propertyMarks against what is published', () => {
  it('says what the draft changed, and which of it is saved', () => {
    const { marks, removed, unsavedRemoved } = propertyMarks(value, original, published)
    expect(Object.fromEntries(marks)).toEqual({
      owner: { mark: 'changed', was: 'ana', unsaved: false },
      tier: { mark: 'changed', was: 'silver', unsaved: true },
      steward: { mark: 'new', unsaved: false },
    })
    expect(removed).toEqual([['legacy', true], ['sla', '1h']])
    expect([...unsavedRemoved]).toEqual(['sla'])
  })

  it('read-only (no edit under way), every change is the saved one', () => {
    const { marks, unsavedRemoved } = propertyMarks(value, undefined, published)
    expect([...marks.values()].every((m) => !m.unsaved)).toBe(true)
    expect(unsavedRemoved.size).toBe(0)
  })
})

describe('PropertyEditor — what the draft changed', () => {
  it('read-only, still says what changed and what it was, and narrows to the changes', () => {
    render(<PropertyEditor value={{ ...value, untouched: 'x' }} onChange={() => {}} readOnly
      published={{ ...published, untouched: 'x' }} groupByPath bare />)
    expect(screen.getAllByText(/^Edited/)).toHaveLength(2)
    expect(screen.getByText('silver', { selector: 'span.line-through' })).toBeInTheDocument()
    expect(screen.getAllByText(', saved in this draft').length).toBeGreaterThan(0)
    // Removed, struck through — nothing to restore from a read-only view.
    expect(screen.getByText('legacy')).toHaveClass('line-through')
    expect(screen.queryByRole('button', { name: /Restore/ })).not.toBeInTheDocument()
    expect(screen.getByText('untouched')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Changes only/ }))
    expect(screen.queryByText('untouched')).not.toBeInTheDocument()
    expect(screen.getByText('owner')).toBeInTheDocument()
  })

  it('editing, Restore puts a removed property back as published', () => {
    const onChange = vi.fn()
    render(<PropertyEditor value={value} onChange={onChange} inline original={original} published={published} groupByPath bare />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[0])
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ legacy: true }))
  })
})
