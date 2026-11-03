/**
 * DuplicateDialog — reads first, then says exactly what a choice will make:
 * live counts per relationship, the copy's name, a big copy flagged and a copy
 * too big to stage refused in words. Duplicate stages the choice as shown.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DuplicateDialog } from '../DuplicateDialog'
import { QUICK_DUPLICATE, type DuplicateChoice, type PreparedDuplicate } from '@/hooks/useDuplicateSubtree'

function prepared(over: Partial<PreparedDuplicate> = {}): PreparedDuplicate {
  return {
    nodeId: 'orders',
    label: 'Orders',
    entityType: 'dataset',
    descendants: 12,
    tooBig: false,
    boundaryRead: true,
    boundaryCapped: { incoming: false, outgoing: false },
    count: (c: DuplicateChoice) => ({
      entities: c.includeDescendants ? 13 : 1,
      internal: c.includeDescendants && c.internal ? 9 : 0,
      incoming: c.incoming ? 3 : 0,
      outgoing: c.outgoing ? 4 : 0,
    }),
    snapshot: {} as never,
    ...over,
  }
}

function setup(p: PreparedDuplicate | null = prepared(), commitResult: string | null = 'urn:staged:copy') {
  const prepare = vi.fn(async () => p)
  const commit = vi.fn(() => commitResult)
  const onDone = vi.fn()
  const onClose = vi.fn()
  render(<DuplicateDialog nodeId="orders" prepare={prepare} commit={commit} onDone={onDone} onClose={onClose} />)
  return { prepare, commit, onDone, onClose }
}

describe('DuplicateDialog', () => {
  it('reads the entity and its boundary, then counts the default choice', async () => {
    const { prepare } = setup()
    expect(screen.getByText(/Reading/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/Creates 13 entities and 9 relationships/)).toBeInTheDocument())
    expect(prepare).toHaveBeenCalledWith('orders', { boundary: true })
    expect(screen.getByDisplayValue('Orders (Copy)')).toBeInTheDocument()
  })

  it('adds incoming and outgoing, and stages exactly that choice under the chosen name', async () => {
    const { commit, onDone, onClose } = setup()
    await screen.findByText(/Creates 13 entities/)
    fireEvent.click(screen.getByRole('switch', { name: /Incoming/ }))
    fireEvent.click(screen.getByRole('switch', { name: /Outgoing/ }))
    expect(screen.getByText(/Creates 13 entities and 16 relationships/)).toBeInTheDocument()
    fireEvent.change(screen.getByDisplayValue('Orders (Copy)'), { target: { value: 'Orders — EU' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Duplicate/ })) })
    expect(commit).toHaveBeenCalledWith(expect.anything(), {
      includeDescendants: true, internal: true, incoming: true, outgoing: true, name: 'Orders — EU',
    })
    expect(onDone).toHaveBeenCalledWith('orders', 'urn:staged:copy', { entities: 13, internal: 9, incoming: 3, outgoing: 4 })
    expect(onClose).toHaveBeenCalled()
  })

  it('just the entity: one copy, and no links inside to keep', async () => {
    setup()
    await screen.findByText(/Creates 13 entities/)
    fireEvent.click(screen.getByRole('radio', { name: /Just this entity/ }))
    expect(screen.getByText(/Creates 1 entity in your draft/)).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: /Links inside the copy/ })).toBeDisabled()
  })

  it('refuses a copy too big to stage, in words', async () => {
    setup(prepared({ tooBig: true }))
    await screen.findByText(/Too big to copy in one go/)
    expect(screen.getByRole('button', { name: /^Duplicate/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: /Just this entity/ }))
    expect(screen.getByRole('button', { name: /^Duplicate/ })).not.toBeDisabled()
  })

  it('a boundary past the limit is not offered, and says what to do instead', async () => {
    setup(prepared({ boundaryCapped: { incoming: true, outgoing: false } }))
    await screen.findByText(/Creates 13 entities/)
    const incoming = screen.getByRole('switch', { name: /Incoming/ })
    expect(incoming).toBeDisabled()
    expect(incoming).toHaveTextContent(/link them in bulk/)
  })

  it('says so when the entity cannot be read, and stages nothing', async () => {
    const { commit } = setup(null)
    await screen.findByText(/couldn.t be read just now/)
    expect(commit).not.toHaveBeenCalled()
  })

  it('Escape closes it', async () => {
    const { onClose } = setup()
    await screen.findByText(/Creates 13 entities/)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(onClose).toHaveBeenCalled()
  })

  it('opens on the quick copy with its name in hand: Enter makes the copy ⌘D would', async () => {
    const { commit, onDone } = setup()
    await screen.findByText(/Creates 13 entities/)
    const nameInput = screen.getByRole('textbox', { name: 'Name of the copy' }) as HTMLInputElement
    await waitFor(() => expect(document.activeElement).toBe(nameInput))
    expect([nameInput.selectionStart, nameInput.selectionEnd]).toEqual([0, 'Orders (Copy)'.length])
    await act(async () => { fireEvent.keyDown(nameInput, { key: 'Enter' }) })
    expect(commit).toHaveBeenCalledWith(expect.anything(), { ...QUICK_DUPLICATE, name: 'Orders (Copy)' })
    expect(onDone).toHaveBeenCalled()
  })

  it('leaves focus on a choice made while it reads', async () => {
    let resolve!: (p: PreparedDuplicate) => void
    const prepare = vi.fn(() => new Promise<PreparedDuplicate | null>((r) => { resolve = r }))
    render(<DuplicateDialog nodeId="orders" prepare={prepare} commit={vi.fn(() => 'urn:staged:copy')} onDone={vi.fn()} onClose={vi.fn()} />)
    const alone = screen.getByRole('radio', { name: /Just this entity/ })
    act(() => { alone.focus() })
    await act(async () => { resolve(prepared()) })
    await screen.findByText(/Creates 13 entities/)
    expect(document.activeElement).toBe(alone)
  })

  it('keeps Tab inside, and says ⌘D copies without asking', async () => {
    setup()
    await screen.findByText(/Creates 13 entities/)
    expect(screen.getByText(/quick copy, without asking/)).toBeInTheDocument()
    const duplicate = screen.getByRole('button', { name: /^Duplicate/ })
    act(() => { duplicate.focus() })
    act(() => { fireEvent.keyDown(document, { key: 'Tab' }) })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })
})
