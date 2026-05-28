/**
 * PropertyEditor — RTL tests for the entity-drawer property editor.
 *
 * Covers the contract the component is responsible for:
 *   • Renders keys/values for an object bag
 *   • Long string values expose an Expand affordance that opens the modal;
 *     editing + Save emits the updated value
 *   • Root search filters rows by key AND value, highlights matches, and shows
 *     an empty state when nothing matches
 *   • readOnly hides add/rename/delete and renders values as plain text, while
 *     still allowing expand-to-read
 *   • add / rename / delete emit correct objects
 *
 * Framer-motion is mocked so AnimatePresence-wrapped modals render their
 * children synchronously. react-markdown is mocked to a passthrough so the
 * preview pane doesn't pull the full markdown pipeline into jsdom.
 */

import React, { useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { PropertyEditor } from './PropertyEditor'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('framer-motion', () => {
  const cache = new Map<string, React.ComponentType<unknown>>()
  const passthrough = (tag: string) => {
    let cmp = cache.get(tag)
    if (!cmp) {
      cmp = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
        function MotionStub(props, ref) {
          return React.createElement(tag, { ...props, ref })
        },
      ) as unknown as React.ComponentType<unknown>
      cache.set(tag, cmp)
    }
    return cmp
  }
  const Reorder = {
    Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Item: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  }
  return {
    motion: new Proxy({}, { get: (_t, key: string) => passthrough(key) }),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Reorder,
  }
})

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="md">{children}</div>,
}))
vi.mock('remark-gfm', () => ({ default: () => undefined }))
vi.mock('@/components/docs/MarkdownComponents', () => ({ markdownComponents: {} }))

// ---------------------------------------------------------------------------
// Harness — keeps the controlled value in state so interactions re-render
// ---------------------------------------------------------------------------

function Harness({
  initial,
  onChange,
  readOnly,
  searchable,
  groupByPath,
}: {
  initial: Record<string, unknown>
  onChange?: (next: unknown) => void
  readOnly?: boolean
  searchable?: boolean
  groupByPath?: boolean
}) {
  const [value, setValue] = useState<unknown>(initial)
  return (
    <PropertyEditor
      value={value}
      onChange={(next) => { setValue(next); onChange?.(next) }}
      readOnly={readOnly}
      searchable={searchable}
      groupByPath={groupByPath}
      bare
    />
  )
}

const LONG = 'Lorem ipsum dolor sit amet, '.repeat(8) // > 120 chars

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PropertyEditor', () => {
  it('renders keys and values for an object bag', () => {
    render(<Harness initial={{ owner: 'analytics', rows: 42, active: true }} />)
    expect(screen.getByText('owner')).toBeInTheDocument()
    expect(screen.getByDisplayValue('analytics')).toBeInTheDocument()
    expect(screen.getByDisplayValue('42')).toBeInTheDocument()
    // boolean renders as a friendly Yes/No toggle
    expect(screen.getByText('Yes')).toBeInTheDocument()
  })

  it('opens the value modal for long strings and saves edits', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ description: LONG }} onChange={onChange} />)

    await user.click(screen.getByTitle('Open editor (Markdown)'))

    const modalEditor = screen.getByPlaceholderText(/Write here/i)
    await user.clear(modalEditor)
    await user.type(modalEditor, 'Short summary')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onChange).toHaveBeenCalledWith({ description: 'Short summary' })
  })

  it('previews markdown in the modal', async () => {
    const user = userEvent.setup()
    render(<Harness initial={{ notes: LONG }} />)
    await user.click(screen.getByTitle('Open editor (Markdown)'))
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByTestId('md')).toBeInTheDocument()
  })

  it('filters rows by key and by value, with an empty state', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        initial={{ owner: 'analytics-team', region: 'us-east', tier: 'gold' }}
        searchable
      />,
    )
    const search = screen.getByPlaceholderText(/Search 3 properties/i)

    // Match by key
    await user.type(search, 'owner')
    expect(screen.getByText('owner')).toBeInTheDocument()
    expect(screen.queryByText('region')).not.toBeInTheDocument()

    // Match by value ("us-east" lives on the `region` row)
    await user.clear(search)
    await user.type(search, 'us-east')
    expect(screen.getByText('region')).toBeInTheDocument()
    expect(screen.queryByText('owner')).not.toBeInTheDocument()

    // No match → empty state
    await user.clear(search)
    await user.type(search, 'zzz-nope')
    expect(screen.getByText(/No properties match/i)).toBeInTheDocument()
  })

  it('readOnly hides edit affordances and renders values as text', () => {
    render(<Harness initial={{ owner: 'analytics', notes: LONG }} readOnly />)
    // No add / delete / rename affordances
    expect(screen.queryByText(/Add property/i)).not.toBeInTheDocument()
    expect(screen.queryByTitle('Delete')).not.toBeInTheDocument()
    // Value is plain text, not an editable control
    expect(screen.queryByDisplayValue('analytics')).not.toBeInTheDocument()
    expect(screen.getByText('analytics')).toBeInTheDocument()
    // Read-only expand-to-view is offered on every string value
    expect(screen.getAllByTitle('View full value').length).toBeGreaterThanOrEqual(1)
  })

  it('adds a new property with a value via the composer', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ owner: 'analytics' }} onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: /Add property/i }))
    await user.type(screen.getByPlaceholderText('Property name'), 'region')
    await user.type(screen.getByPlaceholderText('Enter a value…'), 'us-east')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(onChange).toHaveBeenCalledWith({ owner: 'analytics', region: 'us-east' })
  })

  it('cancels the composer without mutating', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ owner: 'analytics' }} onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: /Add property/i }))
    await user.type(screen.getByPlaceholderText('Property name'), 'region')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByPlaceholderText('Property name')).not.toBeInTheDocument()
    // And the editor is still interactive afterwards (regression for the lockup).
    const ownerRow = screen.getByText('owner').closest('.group') as HTMLElement
    await user.click(within(ownerRow).getByTitle('Delete'))
    expect(onChange).toHaveBeenCalledWith({})
  })

  it('renames a key', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ owner: 'analytics' }} onChange={onChange} />)

    await user.click(screen.getByTitle(/click to rename/i))
    const input = screen.getByDisplayValue('owner')
    await user.clear(input)
    await user.type(input, 'maintainer{Enter}')

    expect(onChange).toHaveBeenCalledWith({ maintainer: 'analytics' })
  })

  it('deletes a property', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ owner: 'analytics', region: 'us' }} onChange={onChange} />)

    const ownerRow = screen.getByText('owner').closest('.group') as HTMLElement
    await user.click(within(ownerRow).getByTitle('Delete'))

    expect(onChange).toHaveBeenCalledWith({ region: 'us' })
  })

  it('opens the editor for ANY string (even short) and saves', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ owner: 'jane' }} onChange={onChange} />)

    // Short value still exposes the always-visible expand affordance.
    await user.click(screen.getByTitle('Open editor (Markdown)'))
    const editor = screen.getByPlaceholderText(/Write here/i)
    await user.clear(editor)
    await user.type(editor, '# Owner')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onChange).toHaveBeenCalledWith({ owner: '# Owner' })
  })

  it('stays interactive after adding a property (regression for lockup)', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ owner: 'analytics' }} onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: /Add property/i }))
    await user.type(screen.getByPlaceholderText('Property name'), 'region')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    // After adding, deleting the original property must still work.
    const ownerRow = screen.getByText('owner').closest('.group') as HTMLElement
    await user.click(within(ownerRow).getByTitle('Delete'))
    expect(onChange).toHaveBeenLastCalledWith({ region: '' })
  })
})

describe('PropertyEditor — path grouping', () => {
  const PATHS = { 'A/x': 1, 'A/y': 2, 'B/z': 3, top: 4 }

  it('groups slash-delimited keys into folders plus root leaves', () => {
    render(<Harness initial={PATHS} groupByPath />)
    // Folder headers
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
    // Root leaf shown directly
    expect(screen.getByText('top')).toBeInTheDocument()
    // Folder A reports 2 items
    const folderA = screen.getByText('A').closest('.group') as HTMLElement
    expect(within(folderA).getByText('2 items')).toBeInTheDocument()
    // Leaves render by their last segment, expanded by default at depth 0
    expect(screen.getByText('x')).toBeInTheDocument()
    expect(screen.getByText('y')).toBeInTheDocument()
  })

  it('collapses and expands a folder', async () => {
    const user = userEvent.setup()
    render(<Harness initial={PATHS} groupByPath />)
    expect(screen.getByText('x')).toBeInTheDocument()
    const folderA = screen.getByText('A').closest('.group') as HTMLElement
    await user.click(within(folderA).getByTitle('Collapse'))
    expect(screen.queryByText('x')).not.toBeInTheDocument()
  })

  it('renames a folder by rewriting all child key prefixes', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={PATHS} groupByPath onChange={onChange} />)
    const folderA = screen.getByText('A').closest('.group') as HTMLElement
    await user.click(within(folderA).getByTitle(/click to rename folder/i))
    const input = within(folderA).getByDisplayValue('A')
    await user.clear(input)
    await user.type(input, 'A2{Enter}')
    expect(onChange).toHaveBeenCalledWith({ 'A2/x': 1, 'A2/y': 2, 'B/z': 3, top: 4 })
  })

  it('deletes a folder and all its keys after confirm', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={PATHS} groupByPath onChange={onChange} />)
    const folderA = screen.getByText('A').closest('.group') as HTMLElement
    await user.click(within(folderA).getByTitle(/Delete folder/i))
    await user.click(within(folderA).getByTitle('Confirm delete'))
    expect(onChange).toHaveBeenCalledWith({ 'B/z': 3, top: 4 })
  })

  it('adds a property scoped to a folder', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ 'B/z': 3 }} groupByPath onChange={onChange} />)
    const folderB = screen.getByText('B').closest('.group') as HTMLElement
    await user.click(within(folderB).getByTitle(/Add property in this folder/i))
    await user.type(screen.getByPlaceholderText('Property name'), 'w')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(onChange).toHaveBeenCalledWith({ 'B/z': 3, 'B/w': '' })
  })

  it('renames a leaf without touching the folder prefix', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ 'A/x': 1 }} groupByPath onChange={onChange} />)
    const leafRow = screen.getByText('x').closest('.group') as HTMLElement
    await user.click(within(leafRow).getByTitle(/click to rename/i))
    const input = within(leafRow).getByDisplayValue('x')
    await user.clear(input)
    await user.type(input, 'x1{Enter}')
    expect(onChange).toHaveBeenCalledWith({ 'A/x1': 1 })
  })

  it('handles a key that is both a leaf and a folder (collision) without data loss', () => {
    render(<Harness initial={{ Technical: 't', 'Technical/Path': 'p' }} groupByPath />)
    // Folder header "Technical" + its inline own-value row share the label
    expect(screen.getAllByText('Technical').length).toBeGreaterThanOrEqual(1)
    // Its own value renders inline, plus the nested leaf
    expect(screen.getByDisplayValue('t')).toBeInTheDocument()
    expect(screen.getByText('Path')).toBeInTheDocument()
    expect(screen.getByDisplayValue('p')).toBeInTheDocument()
  })

  it('nests folders arbitrarily deep (expanding each level)', async () => {
    const user = userEvent.setup()
    render(<Harness initial={{ 'a/b/c/leaf': 1 }} groupByPath />)
    expect(screen.getByText('a')).toBeInTheDocument() // depth 0 expanded
    expect(screen.getByText('b')).toBeInTheDocument()
    // Nested folders default to collapsed — expand to reveal deeper levels
    await user.click(within(screen.getByText('b').closest('.group') as HTMLElement).getByTitle('Expand'))
    expect(screen.getByText('c')).toBeInTheDocument()
    await user.click(within(screen.getByText('c').closest('.group') as HTMLElement).getByTitle('Expand'))
    expect(screen.getByText('leaf')).toBeInTheDocument()
  })

  it('search matches by full path and value and auto-expands', async () => {
    const user = userEvent.setup()
    render(<Harness initial={{ 'A/x': 'alpha', 'B/z': 'beta' }} groupByPath searchable />)
    const search = screen.getByPlaceholderText(/Search 2 properties/i)
    // Match by value text on the A/x row
    await user.type(search, 'alpha')
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(screen.getByText('x')).toBeInTheDocument()
    expect(screen.queryByText('B')).not.toBeInTheDocument()
  })

  it('toggles between Tree and Flat rendering', async () => {
    const user = userEvent.setup()
    render(<Harness initial={{ 'A/x': 1 }} groupByPath searchable />)
    // Tree: folder header present, no full-path key text
    expect(screen.getByText('A')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Flat' }))
    // Flat: the literal key is shown
    expect(screen.getByText('A/x')).toBeInTheDocument()
  })

  it('preserves the original key for weird separators on delete', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ 'a//b': 1, keep: 2 }} groupByPath onChange={onChange} />)
    // 'a//b' → segments ['a','b'] → folder a, leaf b — but the stored key is intact
    const folderA = screen.getByText('a').closest('.group') as HTMLElement
    await user.click(within(folderA).getByTitle(/Delete folder/i))
    await user.click(within(folderA).getByTitle('Confirm delete'))
    expect(onChange).toHaveBeenCalledWith({ keep: 2 })
  })
})

import { isJsonSafe } from './property/fieldTypes'

describe('PropertyEditor — business field types & formatting', () => {
  async function openComposerOnEmpty(user: ReturnType<typeof userEvent.setup>) {
    // Empty object → "Add first property"; opens the composer with a single
    // type chip (no existing rows to collide with).
    await user.click(screen.getByRole('button', { name: /Add first property/i }))
  }

  it('adds a Yes/No (boolean) property as JSON true/false', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{}} onChange={onChange} />)
    await openComposerOnEmpty(user)
    await user.type(screen.getByPlaceholderText('Property name'), 'flag')
    await user.click(screen.getByTitle('Change type'))
    await user.click(screen.getByText('Yes / No'))
    await user.click(screen.getByRole('switch')) // flip No → Yes
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(onChange).toHaveBeenCalledWith({ flag: true })
    expect(isJsonSafe(onChange.mock.calls.at(-1)![0])).toBe(true)
  })

  it('adds a Date property as an ISO string', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{}} onChange={onChange} />)
    await openComposerOnEmpty(user)
    await user.type(screen.getByPlaceholderText('Property name'), 'when')
    await user.click(screen.getByTitle('Change type'))
    await user.click(screen.getByText('Date'))
    await user.click(screen.getByRole('button', { name: 'Add' }))
    const arg = onChange.mock.calls.at(-1)![0] as Record<string, unknown>
    expect(String(arg.when)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(isJsonSafe(arg)).toBe(true)
  })

  it('adds a Tags property as a string[]', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{}} onChange={onChange} />)
    await openComposerOnEmpty(user)
    await user.type(screen.getByPlaceholderText('Property name'), 'labels')
    await user.click(screen.getByTitle('Change type'))
    await user.click(screen.getByText('Tags'))
    const tagInput = screen.getByPlaceholderText(/Type a tag/i)
    await user.type(tagInput, 'red{Enter}blue{Enter}')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(onChange).toHaveBeenCalledWith({ labels: ['red', 'blue'] })
    expect(isJsonSafe(onChange.mock.calls.at(-1)![0])).toBe(true)
  })

  it('toolbar Bold wraps the selection in **…**', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ note: 'hi' }} onChange={onChange} />)
    await user.click(screen.getByTitle('Open editor (Markdown)'))
    const ta = screen.getByPlaceholderText(/Write here/i) as HTMLTextAreaElement
    ta.focus()
    ta.setSelectionRange(0, 2) // select "hi"
    await user.click(screen.getByTitle(/^Bold/))
    expect(ta.value).toBe('**hi**')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onChange).toHaveBeenCalledWith({ note: '**hi**' })
  })

  it('View mode toggles between Formatted and Markdown source', async () => {
    const user = userEvent.setup()
    render(<Harness initial={{ note: '**bold**' }} readOnly searchable groupByPath />)
    // Formatted (default): rendered via markdown (mocked → data-testid="md")
    expect(screen.getAllByTestId('md').length).toBeGreaterThanOrEqual(1)
    // Switch to source: raw markdown text is shown, no markdown render
    await user.click(screen.getByRole('button', { name: 'Markdown' }))
    expect(screen.queryByTestId('md')).not.toBeInTheDocument()
    expect(screen.getByText('**bold**')).toBeInTheDocument()
  })
})
