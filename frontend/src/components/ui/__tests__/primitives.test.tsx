/** The shared primitives: accessible names, keyboard behaviour and states every surface relies on. */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Trash2, Inbox } from 'lucide-react'
import {
  Badge, Button, EmptyState, IconButton, Kbd, Segmented, Skeleton, SkeletonText, Tabs, TabsContent, TabsList, TabsTrigger,
} from '../primitives'
import { formatShortcut, hasPrimaryModifier } from '@/lib/platform'

describe('Button', () => {
  it('is a button that says it is busy while loading, and cannot be pressed', async () => {
    const onClick = vi.fn()
    render(<Button loading onClick={onClick}>Save</Button>)
    const b = screen.getByRole('button', { name: 'Save' })
    expect(b).toHaveAttribute('type', 'button')
    expect(b).toHaveAttribute('aria-busy', 'true')
    expect(b).toBeDisabled()
    await userEvent.click(b)
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('IconButton', () => {
  it('is named by its label', async () => {
    const onClick = vi.fn()
    render(<IconButton icon={Trash2} label="Delete relationship" onClick={onClick} />)
    await userEvent.click(screen.getByRole('button', { name: 'Delete relationship' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('Badge', () => {
  it('renders its text', () => {
    render(<Badge tone="warning">draft</Badge>)
    expect(screen.getByText('draft')).toBeInTheDocument()
  })
})

describe('Tabs', () => {
  it('switches panels with the pointer and the arrow keys', async () => {
    const user = userEvent.setup()
    function Demo() {
      const [v, setV] = useState('view')
      return (
        <Tabs value={v} onValueChange={setV}>
          <TabsList aria-label="Mode">
            <TabsTrigger value="view">View</TabsTrigger>
            <TabsTrigger value="edit">Edit</TabsTrigger>
          </TabsList>
          <TabsContent value="view">viewing</TabsContent>
          <TabsContent value="edit">editing</TabsContent>
        </Tabs>
      )
    }
    render(<Demo />)
    expect(screen.getByText('viewing')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Edit' }))
    expect(screen.getByText('editing')).toBeInTheDocument()
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('tab', { name: 'View' })).toHaveAttribute('aria-selected', 'true')
  })
})

describe('Segmented', () => {
  it('is one radiogroup; arrows, Home and End move the choice and skip disabled options', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    function Demo() {
      const [v, setV] = useState<'all' | 'draft' | 'published'>('all')
      return (
        <Segmented label="Show" value={v} onChange={(x) => { setV(x); onChange(x) }}
          options={[{ value: 'all', label: 'All', count: 12 }, { value: 'draft', label: 'This draft', disabled: true }, { value: 'published', label: 'Published' }]} />
      )
    }
    render(<Demo />)
    expect(screen.getByRole('radiogroup', { name: 'Show' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /All/ })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('radio', { name: 'Published' })).toHaveAttribute('tabindex', '-1')
    screen.getByRole('radio', { name: /All/ }).focus()
    await user.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenLastCalledWith('published')
    expect(screen.getByRole('radio', { name: 'Published' })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(onChange).toHaveBeenLastCalledWith('all')
  })
})

describe('EmptyState, Skeleton', () => {
  it('says what is missing and offers the action', async () => {
    const onClick = vi.fn()
    render(<EmptyState icon={Inbox} title="No history yet" description="Changes appear here once saved." action={{ label: 'Open a draft', onClick }} />)
    expect(screen.getByText('No history yet')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Open a draft' }))
    expect(onClick).toHaveBeenCalled()
  })

  it('skeletons are hidden from assistive tech', () => {
    const { container } = render(<><Skeleton className="h-4" /><SkeletonText lines={2} /></>)
    container.querySelectorAll('div').forEach((d) => expect(d).toHaveAttribute('aria-hidden'))
  })
})

describe('shortcuts', () => {
  it('are written the platform’s way', () => {
    expect(formatShortcut('mod+s', true)).toBe('⌘S')
    expect(formatShortcut('mod+s', false)).toBe('Ctrl+S')
    expect(formatShortcut('mod+enter', true)).toBe('⌘↵')
    expect(formatShortcut('shift+mod+z', false)).toBe('Shift+Ctrl+Z')
  })

  it('Kbd renders the formatted shortcut', () => {
    render(<Kbd shortcut="mod+s" />)
    expect(screen.getByText(/⌘S|Ctrl\+S/)).toBeInTheDocument()
  })

  it('the primary modifier is Ctrl off Apple (jsdom)', () => {
    expect(hasPrimaryModifier({ metaKey: false, ctrlKey: true })).toBe(true)
    expect(hasPrimaryModifier({ metaKey: true, ctrlKey: false })).toBe(false)
  })
})
