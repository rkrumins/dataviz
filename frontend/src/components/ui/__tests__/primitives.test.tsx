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

  it('scrolls a strip wider than its room, with a fade on the side that has more', () => {
    render(
      <Tabs defaultValue="a">
        <TabsList look="underline" scrollable aria-label="Sections">
          <TabsTrigger value="a" icon={Inbox}>Alpha</TabsTrigger>
          <TabsTrigger value="b" icon={Trash2}>Beta</TabsTrigger>
        </TabsList>
      </Tabs>,
    )
    const strip = screen.getByRole('tablist', { name: 'Sections' })
    expect(strip.className).toMatch(/overflow-x-auto/)
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.className).toMatch(/shrink-0/)
      expect(tab.className).toMatch(/whitespace-nowrap/)
      expect(tab.querySelector('svg')?.getAttribute('class')).toMatch(/shrink-0/)
    }
    // Nothing overflows in jsdom (no layout), so neither fade shows.
    const fades = strip.parentElement!.querySelectorAll('[data-tabs-fade]')
    expect(fades).toHaveLength(2)
    for (const fade of fades) expect(fade.className).toMatch(/opacity-0/)
  })

  it('shows a chevron on the side with more, which scrolls the strip on', async () => {
    // The strip shows 300px of 600px of tabs, scrolled to its start: more to the right only.
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.getAttribute('role') === 'tablist' ? 300 : 0
      }),
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.getAttribute('role') === 'tablist' ? 600 : 0
      }),
    ]
    const scrollBy = vi.fn()
    HTMLElement.prototype.scrollBy = scrollBy
    try {
      render(
        <Tabs defaultValue="a">
          <TabsList look="underline" scrollable aria-label="Sections">
            <TabsTrigger value="a">Alpha</TabsTrigger>
            <TabsTrigger value="b">Beta</TabsTrigger>
          </TabsList>
        </Tabs>,
      )
      const wrap = screen.getByRole('tablist', { name: 'Sections' }).parentElement!
      const left = wrap.querySelector<HTMLButtonElement>('[data-tabs-scroll="left"]')!
      const right = wrap.querySelector<HTMLButtonElement>('[data-tabs-scroll="right"]')!
      expect(left).toBeDisabled()
      expect(right).toBeEnabled()
      expect(right).toHaveAttribute('tabindex', '-1')                 // the arrow keys move along a tablist
      expect(wrap.querySelector('[data-tabs-fade="right"]')?.className).toMatch(/opacity-100/)
      await userEvent.click(right)
      expect(scrollBy).toHaveBeenCalledWith({ left: 210, behavior: 'smooth' })
    } finally {
      for (const spy of spies) spy.mockRestore()
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollBy
    }
  })

  it('leaves a strip that isn’t scrollable as it was', () => {
    render(
      <Tabs defaultValue="a">
        <TabsList aria-label="Plain"><TabsTrigger value="a">Alpha</TabsTrigger></TabsList>
      </Tabs>,
    )
    const strip = screen.getByRole('tablist', { name: 'Plain' })
    expect(strip.className).not.toMatch(/overflow-x-auto/)
    expect(strip.parentElement!.querySelector('[data-tabs-fade]')).toBeNull()
    expect(screen.getByRole('tab').className).not.toMatch(/whitespace-nowrap/)
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
