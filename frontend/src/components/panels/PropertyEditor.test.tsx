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
}: {
  initial: Record<string, unknown>
  onChange?: (next: unknown) => void
  readOnly?: boolean
  searchable?: boolean
}) {
  const [value, setValue] = useState<unknown>(initial)
  return (
    <PropertyEditor
      value={value}
      onChange={(next) => { setValue(next); onChange?.(next) }}
      readOnly={readOnly}
      searchable={searchable}
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
    expect(screen.getByText('true')).toBeInTheDocument()
  })

  it('opens the value modal for long strings and saves edits', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ description: LONG }} onChange={onChange} />)

    await user.click(screen.getByTitle('Expand & edit'))

    const modalEditor = screen.getByPlaceholderText(/Markdown is supported/i)
    await user.clear(modalEditor)
    await user.type(modalEditor, 'Short summary')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onChange).toHaveBeenCalledWith({ description: 'Short summary' })
  })

  it('previews markdown in the modal', async () => {
    const user = userEvent.setup()
    render(<Harness initial={{ notes: LONG }} />)
    await user.click(screen.getByTitle('Expand & edit'))
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
    // Long value still offers a read-only expand
    expect(screen.getByTitle('View full value')).toBeInTheDocument()
  })

  it('adds a new property', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={{ owner: 'analytics' }} onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: /Add property/i }))
    await user.type(screen.getByPlaceholderText('key name'), 'region')
    await user.click(screen.getByTitle('Add'))

    expect(onChange).toHaveBeenCalledWith({ owner: 'analytics', region: '' })
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
})
