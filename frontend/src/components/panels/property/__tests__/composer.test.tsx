/**
 * Adding a property: what others of the type carry is offered as the name is typed; a value is read
 * as what it is (a number, yes/no, a date, a link); several "name: value" lines pasted are added in
 * one change; ⌘↵ adds one and starts the next; a name already there offers to update it instead.
 * The list's own adder is the larger form; one inside a folder keeps its size.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PropertyEditor } from '../../PropertyEditor'
import { detectValue, parsePastedLines, rankSuggestions } from '../composerModel'
import { useRecentPropertyKeys } from '@/store/recentPropertyKeys'

beforeEach(() => { useRecentPropertyKeys.setState({ keys: [] }) })

describe('composerModel', () => {
  it('reads a typed value as what it is', () => {
    expect(detectValue('42')).toEqual({ type: 'number', value: 42 })
    expect(detectValue('1,250.5')).toEqual({ type: 'number', value: 1250.5 })
    expect(detectValue('007')).toEqual({ type: 'text', value: '007' })
    expect(detectValue('Yes')).toEqual({ type: 'boolean', value: true })
    expect(detectValue('2026-11-18')).toEqual({ type: 'date', value: '2026-11-18' })
    expect(detectValue('https://example.com/x')).toEqual({ type: 'url', value: 'https://example.com/x' })
    expect(detectValue('Finance')).toEqual({ type: 'text', value: 'Finance' })
  })

  it('reads several pasted lines as several properties — or none from one line', () => {
    expect(parsePastedLines('owner: Finance\nretention = 90\npii\tyes\n\nnot a pair')).toEqual([
      { key: 'owner', value: 'Finance', type: 'text' },
      { key: 'retention', value: 90, type: 'number' },
      { key: 'pii', value: true, type: 'boolean' },
    ])
    expect(parsePastedLines('owner: Finance')).toEqual([])
  })

  it('offers what others carry first, most common, then what was used recently — never one already there', () => {
    const peers = [{ key: 'owner', count: 12, examples: ['Finance'] }, { key: 'tier', count: 30, examples: [] }, { key: 'domain', count: 4, examples: [] }]
    expect(rankSuggestions('', peers, ['steward', 'tier'], ['domain']).map((s) => s.key)).toEqual(['tier', 'owner', 'steward'])
    expect(rankSuggestions('o', peers, [], []).map((s) => s.key)).toEqual(['owner', 'domain'])
  })
})

describe('PropertyEditor — adding a property', () => {
  const peers = [{ key: 'owner', count: 12, examples: ['Finance'], type: 'text' as const }]
  const open = (onChange = vi.fn(), value: Record<string, unknown> = { tier: 'gold' }) => {
    render(<PropertyEditor value={value} onChange={onChange} inline groupByPath bare suggestions={peers} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add property' }))
    return onChange
  }

  it('offers what others of the type carry, and reads the value as a number', () => {
    const onChange = open()
    const name = screen.getByRole('combobox', { name: 'Property name' })
    fireEvent.change(name, { target: { value: 'ow' } })
    const option = within(screen.getByRole('listbox', { name: 'Suggested names' })).getByRole('option', { name: /owner/ })
    expect(option).toHaveTextContent('12 others · e.g. Finance')
    fireEvent.mouseDown(option)
    expect(name).toHaveValue('owner')
    fireEvent.change(screen.getByRole('textbox', { name: 'Value' }), { target: { value: '90' } })
    expect(screen.getByText('read as number')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Value' }), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith({ tier: 'gold', owner: 90 })
    expect(useRecentPropertyKeys.getState().keys).toEqual(['owner'])
  })

  it('offers every name others carry, not the first six, and reaches the last by keyboard', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ key: `col_${i + 1}_name`, count: 50 - i, examples: [] }))
    render(<PropertyEditor value={{ tier: 'gold' }} onChange={vi.fn()} inline groupByPath bare suggestions={many} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add property' }))
    const name = screen.getByRole('combobox', { name: 'Property name' })
    fireEvent.focus(name)
    const list = screen.getByRole('listbox', { name: 'Suggested names' })
    expect(within(list).getAllByRole('option')).toHaveLength(15)
    expect(name).toHaveAttribute('aria-controls', list.id)
    for (let i = 0; i < 20; i++) fireEvent.keyDown(name, { key: 'ArrowDown' })
    expect(name).toHaveAttribute('aria-activedescendant', within(list).getByRole('option', { name: /col_15_name/ }).id)
    fireEvent.keyDown(name, { key: 'Enter' })
    expect(name).toHaveValue('col_15_name')
  })

  it('adds several pasted properties in one change', () => {
    const onChange = open()
    fireEvent.paste(screen.getByRole('combobox', { name: 'Property name' }), {
      clipboardData: { getData: () => 'owner: Finance\nretention: 90\ntier: silver' },
    })
    expect(screen.getByText(/3 properties pasted/)).toHaveTextContent('1 already there')
    fireEvent.click(screen.getByRole('button', { name: 'Add 2' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ tier: 'gold', owner: 'Finance', retention: 90 })
  })

  it('⌘↵ adds one and starts the next', () => {
    const onChange = open()
    const name = screen.getByRole('combobox', { name: 'Property name' })
    fireEvent.change(name, { target: { value: 'domain' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Value' }), { target: { value: 'Sales' } })
    act(() => { fireEvent.keyDown(name, { key: 'Enter', metaKey: true }) })
    expect(onChange).toHaveBeenCalledWith({ tier: 'gold', domain: 'Sales' })
    expect(screen.getByRole('combobox', { name: 'Property name' })).toHaveValue('')
  })

  it("is the larger form as the list's own adder, and keeps its size inside a folder", () => {
    render(<PropertyEditor value={{ tier: 'gold', 'B/z': 3 }} onChange={vi.fn()} inline groupByPath bare />)
    // The list's own adder comes last, after the folders' sections.
    fireEvent.click(screen.getAllByRole('button', { name: 'Add property' }).at(-1)!)
    expect(screen.getByRole('combobox', { name: 'Property name' })).toHaveClass('h-10')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(screen.getByRole('region', { name: 'B' })).getByRole('button', { name: 'Add property in this folder' }))
    expect(screen.getByRole('combobox', { name: 'Property name' })).not.toHaveClass('h-10')
  })

  it('a name already there offers to update it instead', () => {
    const onChange = open()
    fireEvent.change(screen.getByRole('combobox', { name: 'Property name' }), { target: { value: 'tier' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Value' }), { target: { value: 'platinum' } })
    expect(screen.getByText(/“tier” already exists/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Update it instead' }))
    expect(onChange).toHaveBeenCalledWith({ tier: 'platinum' })
  })
})
