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
import { usePersonaStore } from '@/store/persona'

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
// Both maps: the editor renders user-authored text, so it uses the
// narrowed one (no mermaid / lineage-demo / tour widgets).
vi.mock('@/components/docs/MarkdownComponents', () => ({
  markdownComponents: {},
  userContentMarkdownComponents: {},
}))

// TipTap can't render in jsdom; stub the WYSIWYG editor as a controlled
// textarea that round-trips its value. Covers both the inline + modal (rich)
// uses (same resolved module). Stores plain text, mirroring Markdown storage.
vi.mock('./property/RichMarkdownEditor', () => ({
  default: ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
    <textarea
      data-testid="rich-editor"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}))

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
    // text value shows a clamped formatted preview (click-to-edit in the modal)
    expect(screen.getByText('analytics')).toBeInTheDocument()
    expect(screen.getByDisplayValue('42')).toBeInTheDocument()
    // boolean renders as a friendly Yes/No toggle
    expect(screen.getByText('Yes')).toBeInTheDocument()
  })

  it('opens the value modal for long strings and saves edits', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ description: LONG }} onChange={onChange} />)

    await user.click(screen.getByLabelText('Open editor (Markdown)'))

    // Modal opens in Rich mode (lazy stub) — its textarea carries the placeholder.
    const modalEditor = await screen.findByPlaceholderText(/Write here/i)
    await user.clear(modalEditor)
    await user.type(modalEditor, 'Short summary')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onChange).toHaveBeenCalledWith({ description: 'Short summary' })
  })

  it('previews markdown in the modal (Source mode)', async () => {
    const user = userEvent.setup()
    render(<Harness initial={{ notes: LONG }} />)
    await user.click(screen.getByLabelText('Open editor (Markdown)'))
    // Preview pane lives in Source mode; switch to it first. (The list cell also
    // renders markdown, so assert the preview ADDS a render.)
    const before = screen.queryAllByTestId('md').length
    await user.click(screen.getByRole('button', { name: 'source' }))
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getAllByTestId('md').length).toBeGreaterThan(before)
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
    const lines = Array(8).fill('a line of content').join('\n')
    render(<Harness initial={{ owner: 'analytics', notes: lines }} readOnly />)
    // No add / delete / rename affordances
    expect(screen.queryByText(/Add property/i)).not.toBeInTheDocument()
    expect(screen.queryByTitle('Delete')).not.toBeInTheDocument()
    // Value is plain text, not an editable control
    expect(screen.queryByDisplayValue('analytics')).not.toBeInTheDocument()
    expect(screen.getByText('analytics')).toBeInTheDocument()
    // The full viewer is offered where the text is clamped — not on a short value
    expect(screen.getAllByRole('button', { name: 'View full value' })).toHaveLength(1)
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
    await user.click(within(ownerRow).getByRole('button', { name: /^Delete / }))
    expect(onChange).toHaveBeenCalledWith({})
  })

  it('renames a key', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ owner: 'analytics' }} onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: /^Rename / }))
    const input = screen.getByDisplayValue('owner')
    await user.clear(input)
    await user.type(input, 'maintainer{Enter}')

    expect(onChange).toHaveBeenCalledWith({ maintainer: 'analytics' })
  })

  it('puts a renamed key back on Esc — even when the drawer blurs the field as it closes the edit', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    // The entity drawer blurs whatever is focused on Escape (DrawerShell): the blur must not rename.
    render(
      <div onKeyDown={(e) => { if (e.key === 'Escape') (document.activeElement as HTMLElement | null)?.blur() }}>
        <Harness initial={{ owner: 'analytics' }} onChange={onChange} />
      </div>,
    )
    await user.click(screen.getByRole('button', { name: /^Rename / }))
    const input = screen.getByDisplayValue('owner')
    await user.clear(input)
    await user.type(input, 'maintainer{Escape}')
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText('owner')).toBeInTheDocument()
    // And the next rename still lands.
    await user.click(screen.getByRole('button', { name: /^Rename / }))
    const again = screen.getByDisplayValue('owner')
    await user.clear(again)
    await user.type(again, 'steward{Enter}')
    expect(onChange).toHaveBeenCalledWith({ steward: 'analytics' })
  })

  it('puts a renamed folder back on Esc', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <div onKeyDown={(e) => { if (e.key === 'Escape') (document.activeElement as HTMLElement | null)?.blur() }}>
        <Harness initial={{ 'A/x': 1, 'A/y': 2, 'B/z': 3, top: 4 }} groupByPath onChange={onChange} />
      </div>,
    )
    const folderA = screen.getByRole('region', { name: 'A' })
    await user.click(within(folderA).getByRole('button', { name: 'Rename folder A' }))
    const input = within(folderA).getByDisplayValue('A')
    await user.clear(input)
    await user.type(input, 'Z{Escape}')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('deletes a property', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ owner: 'analytics', region: 'us' }} onChange={onChange} />)

    const ownerRow = screen.getByText('owner').closest('.group') as HTMLElement
    await user.click(within(ownerRow).getByRole('button', { name: /^Delete / }))

    expect(onChange).toHaveBeenCalledWith({ region: 'us' })
  })

  it('opens the editor for ANY string (even short) and saves', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ owner: 'jane' }} onChange={onChange} />)

    // Short value still exposes the always-visible expand affordance.
    await user.click(screen.getByLabelText('Open editor (Markdown)'))
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
    await user.click(within(ownerRow).getByRole('button', { name: /^Delete / }))
    expect(onChange).toHaveBeenLastCalledWith({ region: '' })
  })
})

describe('PropertyEditor — path grouping', () => {
  const PATHS = { 'A/x': 1, 'A/y': 2, 'B/z': 3, top: 4 }

  it('groups slash-delimited keys into sections, what sits in no folder under General', () => {
    render(<Harness initial={PATHS} groupByPath />)
    // A section per folder, and General first
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['General', 'A', 'B'])
    expect(within(screen.getByRole('region', { name: 'General' })).getByText('top')).toBeInTheDocument()
    // Section A says how many it holds
    const folderA = screen.getByRole('region', { name: 'A' })
    expect(within(folderA).getByText('2 properties')).toBeInTheDocument()
    // Leaves render by their last segment, expanded by default at depth 0
    expect(screen.getByText('x')).toBeInTheDocument()
    expect(screen.getByText('y')).toBeInTheDocument()
  })

  it('collapses and expands a folder', async () => {
    const user = userEvent.setup()
    render(<Harness initial={PATHS} groupByPath />)
    expect(screen.getByText('x')).toBeInTheDocument()
    const folderA = screen.getByRole('region', { name: 'A' })
    await user.click(within(folderA).getByRole('button', { name: 'Collapse' }))
    expect(screen.queryByText('x')).not.toBeInTheDocument()
  })

  it('renames a folder by rewriting all child key prefixes', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={PATHS} groupByPath onChange={onChange} />)
    const folderA = screen.getByRole('region', { name: 'A' })
    await user.click(within(folderA).getByRole('button', { name: 'Rename folder A' }))
    const input = within(folderA).getByDisplayValue('A')
    await user.clear(input)
    await user.type(input, 'A2{Enter}')
    expect(onChange).toHaveBeenCalledWith({ 'A2/x': 1, 'A2/y': 2, 'B/z': 3, top: 4 })
  })

  it('deletes a folder and all its keys after confirm', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={PATHS} groupByPath onChange={onChange} />)
    const folderA = screen.getByRole('region', { name: 'A' })
    await user.click(within(folderA).getByRole('button', { name: /Delete folder/i }))
    await user.click(within(folderA).getByRole('button', { name: 'Delete 2?' }))
    expect(onChange).toHaveBeenCalledWith({ 'B/z': 3, top: 4 })
  })

  it('adds a property scoped to a folder', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ 'B/z': 3 }} groupByPath onChange={onChange} />)
    const folderB = screen.getByRole('region', { name: 'B' })
    await user.click(within(folderB).getByRole('button', { name: 'Add property in this folder' }))
    await user.type(screen.getByPlaceholderText('Property name'), 'w')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(onChange).toHaveBeenCalledWith({ 'B/z': 3, 'B/w': '' })
  })

  it('renames a leaf without touching the folder prefix', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ 'A/x': 1 }} groupByPath onChange={onChange} />)
    const leafRow = screen.getByText('x').closest('.group') as HTMLElement
    await user.click(within(leafRow).getByRole('button', { name: /^Rename / }))
    const input = within(leafRow).getByDisplayValue('x')
    await user.clear(input)
    await user.type(input, 'x1{Enter}')
    expect(onChange).toHaveBeenCalledWith({ 'A/x1': 1 })
  })

  it('adds the FIRST property to an empty grouped bag and shows it', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{}} groupByPath searchable onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: /Add property/i }))
    await user.type(screen.getByPlaceholderText('Property name'), 'abc')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(onChange).toHaveBeenCalledWith({ abc: '' })
    expect(screen.getByText('abc')).toBeInTheDocument()
  })

  it('adds two properties in sequence (stable api stays fresh)', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{}} groupByPath searchable onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: /Add property/i }))
    await user.type(screen.getByPlaceholderText('Property name'), 'one')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    // second add must see the first key already present
    await user.click(screen.getByRole('button', { name: /Add property/i }))
    await user.type(screen.getByPlaceholderText('Property name'), 'two')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(onChange).toHaveBeenLastCalledWith({ one: '', two: '' })
  })

  it('handles a key that is both a leaf and a folder (collision) without data loss', () => {
    render(<Harness initial={{ Technical: 't', 'Technical/Path': 'p' }} groupByPath />)
    // Folder header "Technical" + its inline own-value row share the label
    expect(screen.getAllByText('Technical').length).toBeGreaterThanOrEqual(1)
    // Its own value renders as a clamped preview, plus the nested leaf
    expect(screen.getByText('t')).toBeInTheDocument()
    expect(screen.getByText('Path')).toBeInTheDocument()
    expect(screen.getByText('p')).toBeInTheDocument()
  })

  it('nests folders arbitrarily deep (expanding each level)', async () => {
    const user = userEvent.setup()
    render(<Harness initial={{ 'a/b/c/leaf': 1 }} groupByPath />)
    expect(screen.getByText('a')).toBeInTheDocument() // the section is open
    expect(screen.getByText('b')).toBeInTheDocument()
    // A folder inside a section waits to be opened — expand to reveal deeper levels
    await user.click(within(screen.getByRole('group', { name: 'b' })).getByRole('button', { name: 'Expand' }))
    expect(screen.getByText('c')).toBeInTheDocument()
    await user.click(within(screen.getByRole('group', { name: 'c' })).getByRole('button', { name: 'Expand' }))
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

  it('toggles between Sections and Flat rendering', async () => {
    const user = userEvent.setup()
    render(<Harness initial={{ 'A/x': 1 }} groupByPath searchable />)
    // Sections: folder header present, no full-path key text
    expect(screen.getByText('A')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'View options' }))
    await user.click(await screen.findByRole('menuitemradio', { name: /Flat/ }))
    // Flat: the literal key is shown, its folder quieter than its own name
    expect(screen.getByRole('button', { name: 'Rename A/x' })).toHaveTextContent('A/x')
  })

  it('preserves the original key for weird separators on delete', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ 'a//b': 1, keep: 2 }} groupByPath onChange={onChange} />)
    // 'a//b' → segments ['a','b'] → folder a, leaf b — but the stored key is intact
    const folderA = screen.getByRole('region', { name: 'a' })
    await user.click(within(folderA).getByRole('button', { name: /Delete folder/i }))
    await user.click(within(folderA).getByRole('button', { name: 'Delete 1?' }))
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
    await user.click(screen.getByLabelText('Change type'))
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
    await user.click(screen.getByLabelText('Change type'))
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
    await user.click(screen.getByLabelText('Change type'))
    await user.click(screen.getByText('Tags'))
    const tagInput = screen.getByPlaceholderText(/Type a tag/i)
    await user.type(tagInput, 'red{Enter}blue{Enter}')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(onChange).toHaveBeenCalledWith({ labels: ['red', 'blue'] })
    expect(isJsonSafe(onChange.mock.calls.at(-1)![0])).toBe(true)
  })

  it('Source-mode toolbar Bold wraps the selection in **…**', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ note: 'hi' }} onChange={onChange} />)
    await user.click(screen.getByLabelText('Open editor (Markdown)'))
    // Switch to Source mode where the raw textarea + insert-markdown toolbar live.
    await user.click(screen.getByRole('button', { name: 'source' }))
    const ta = screen.getByPlaceholderText(/Write here/i) as HTMLTextAreaElement
    ta.focus()
    ta.setSelectionRange(0, 2) // select "hi"
    await user.click(screen.getByTitle(/^Bold/))
    expect(ta.value).toBe('**hi**')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onChange).toHaveBeenCalledWith({ note: '**hi**' })
  })

  it('View mode toggles between Formatted and Markdown source — in the Technical view', async () => {
    const user = userEvent.setup()
    usePersonaStore.setState({ mode: 'technical' })
    render(<Harness initial={{ note: '**bold**' }} readOnly searchable groupByPath />)
    // Formatted (default): rendered via markdown (mocked → data-testid="md")
    expect(screen.getAllByTestId('md').length).toBeGreaterThanOrEqual(1)
    // Switch to source: raw markdown text is shown, no markdown render
    await user.click(screen.getByRole('button', { name: 'View options' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Markdown' }))
    expect(screen.queryByTestId('md')).not.toBeInTheDocument()
    expect(screen.getByText('**bold**')).toBeInTheDocument()
  })
})

describe('PropertyEditor — editor modal save/cancel/guard & clamping', () => {
  it('modal Save commits the edited Markdown', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ note: 'hi' }} onChange={onChange} />)
    await user.click(screen.getByLabelText('Open editor (Markdown)'))
    const ed = await screen.findByPlaceholderText(/Write here/i)
    await user.clear(ed)
    await user.type(ed, 'hello world')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onChange).toHaveBeenCalledWith({ note: 'hello world' })
  })

  it('modal Cancel with no changes closes without committing', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ note: 'hi' }} onChange={onChange} />)
    await user.click(screen.getByLabelText('Open editor (Markdown)'))
    await screen.findByPlaceholderText(/Write here/i)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByPlaceholderText(/Write here/i)).not.toBeInTheDocument()
  })

  it('modal warns before discarding unsaved changes', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ note: 'hi' }} onChange={onChange} />)
    await user.click(screen.getByLabelText('Open editor (Markdown)'))
    const ed = await screen.findByPlaceholderText(/Write here/i)
    await user.type(ed, ' there')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    // Discard confirmation appears instead of closing
    expect(screen.getByText(/Discard unsaved changes/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByPlaceholderText(/Write here/i)).not.toBeInTheDocument()
  })

  it('long values: Show more grows in-drawer; Full screen opens the maximized modal', async () => {
    const user = userEvent.setup()
    const big = Array(8).fill('a line of content').join('\n') // > 5 lines
    render(<Harness initial={{ note: big }} />)
    // Show more grows it in the drawer (no modal opens)
    await user.click(screen.getByRole('button', { name: /Show more/i }))
    expect(screen.getByRole('button', { name: /Show less/i })).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/Write here/i)).not.toBeInTheDocument()
    // Full screen opens the editor modal, already maximized (Restore visible)
    await user.click(screen.getByRole('button', { name: /Full screen/i }))
    expect(await screen.findByPlaceholderText(/Write here/i)).toBeInTheDocument()
    expect(screen.getByTitle('Restore')).toBeInTheDocument()
  })

  it('very long values step out: Show more, then Show all, then Show less', async () => {
    const user = userEvent.setup()
    const huge = Array(40).fill('a line of content').join('\n')
    render(<Harness initial={{ note: huge }} readOnly />)
    await user.click(screen.getByRole('button', { name: /Show more/i }))
    await user.click(screen.getByRole('button', { name: /Show all 40 lines/i }))
    await user.click(screen.getByRole('button', { name: /Show less/i }))
    expect(screen.getByRole('button', { name: /Show more/i })).toBeInTheDocument()
  })

  it('short values (≤5 lines) show no Show more / Full screen controls', () => {
    render(<Harness initial={{ note: 'a short single-line value' }} />)
    expect(screen.queryByRole('button', { name: /Show more/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Full screen/i })).not.toBeInTheDocument()
  })

  it('renders the modal in a body portal (escapes the drawer containing block)', async () => {
    const user = userEvent.setup()
    const { container } = render(<Harness initial={{ note: 'hi' }} />)
    await user.click(screen.getByLabelText('Open editor (Markdown)'))
    const editor = await screen.findByPlaceholderText(/Write here/i)
    // Found document-wide, but NOT inside the component's own container subtree.
    expect(editor).toBeInTheDocument()
    expect(container.contains(editor)).toBe(false)
  })
})

describe('PropertyEditor — keys as stored, polished', () => {
  it('shows no lock on a read-only row — only on a key kept as it is', () => {
    const { unmount } = render(<PropertyEditor value={{ owner: 'ana' }} onChange={() => {}} readOnly bare />)
    expect(screen.getByText('owner')).toBeInTheDocument()
    expect(screen.queryByLabelText('Locked')).not.toBeInTheDocument()
    unmount()
    render(<PropertyEditor value={{ id: 'x1', owner: 'ana' }} onChange={() => {}} readOnlyKeys={['id']} bare />)
    expect(screen.getAllByLabelText('Locked')).toHaveLength(1)
  })

  it('names list items Item 1, Item 2', () => {
    render(<PropertyEditor value={{ steps: [{ a: 1 }, { b: 2 }] }} onChange={() => {}} readOnly bare />)
    expect(screen.getByText('Item 1')).toBeInTheDocument()
    expect(screen.getByText('Item 2')).toBeInTheDocument()
    expect(screen.queryByText('[0]')).not.toBeInTheDocument()
  })
})

describe('PropertyEditor — sections and the View menu', () => {
  it('takes its sections from the keys’ own folders, at any depth — nothing named in advance', async () => {
    const user = userEvent.setup()
    render(<PropertyEditor value={{ 'Technical/path': '/data/orders', 'Technical/system': 'Snowflake', 'Technical/Storage/format': 'parquet',
      'Finance/Cost centre': 'CC-42', owner: 'ana' }} onChange={() => {}} readOnly groupByPath bare />)
    // A section per top-level folder, in the order the keys come; what has no folder under General.
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['General', 'Technical', 'Finance'])
    const technical = screen.getByRole('region', { name: 'Technical' })
    expect(within(technical).getByText('3 properties')).toBeInTheDocument()
    expect(within(technical).getByText('path')).toBeInTheDocument()
    expect(within(technical).getByText('system')).toBeInTheDocument()
    // Technical/Storage is a folder inside Technical, holding format.
    const storage = within(technical).getByRole('group', { name: 'Storage' })
    await user.click(within(storage).getByRole('button', { name: 'Expand' }))
    expect(within(storage).getByText('format')).toBeInTheDocument()
    expect(within(storage).getByText('parquet')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Finance' })).getByText('Cost centre')).toBeInTheDocument()
  })

  it('offers the text as stored only in the Technical view', async () => {
    const user = userEvent.setup()
    usePersonaStore.setState({ mode: 'business' })
    render(<Harness initial={{ note: '**bold**' }} readOnly searchable groupByPath />)
    await user.click(screen.getByRole('button', { name: 'View options' }))
    expect(await screen.findByRole('menuitemradio', { name: /Flat/ })).toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio', { name: 'Markdown' })).not.toBeInTheDocument()
  })

  it('says what changed in each section, closed or open', () => {
    render(<PropertyEditor value={{ 'Tech/a': 2, 'Tech/b': 1, top: 1 }} onChange={() => {}} readOnly groupByPath bare
      published={{ 'Tech/a': 1, 'Tech/c': 3, top: 1 }} />)
    const tech = screen.getByRole('region', { name: 'Tech' })
    expect(within(tech).getByText('1 edited, 1 added, 1 removed')).toBeInTheDocument()
  })

  it('opens the first two of many sections, and remembers what was opened for the kind of entity', async () => {
    const user = userEvent.setup()
    const value = { 'A/x': 1, 'B/x': 1, 'C/x': 1, 'D/x': 1 }
    const { unmount } = render(<PropertyEditor value={value} onChange={() => {}} readOnly groupByPath bare sectionsKey="Table" />)
    const open = () => screen.getAllByRole('button', { name: /^(Collapse|Expand)$/ }).map((b) => b.getAttribute('aria-expanded'))
    expect(open()).toEqual(['true', 'true', 'false', 'false'])
    await user.click(within(screen.getByRole('region', { name: 'D' })).getByRole('button', { name: 'Expand' }))
    unmount()
    render(<PropertyEditor value={value} onChange={() => {}} readOnly groupByPath bare sectionsKey="Table" />)
    expect(open()).toEqual(['true', 'true', 'false', 'true'])
  })

  it('marks what is shown at a glance, and features one from its row', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(<PropertyEditor value={{ owner: 'ana', tier: 'gold' }} onChange={() => {}} readOnly groupByPath bare
      featuredKeys={['owner']} onToggleFeatured={onToggle} />)
    const ownerRow = screen.getByText('owner').closest('.group') as HTMLElement
    expect(within(ownerRow).getByText('At a glance')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show tier at a glance' }))
    expect(onToggle).toHaveBeenCalledWith('tier')
  })
})
