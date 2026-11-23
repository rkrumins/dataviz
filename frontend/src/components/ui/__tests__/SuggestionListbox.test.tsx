/**
 * SuggestionListbox: every match is offered and reachable — scrolled past the first few with the
 * mouse, by its scrollbar without the field losing focus (which closed the list under the pointer),
 * and by the arrow keys to the last one. Over a hundred rows, only those in view are drawn. It opens
 * above its field when below has no room, and never past the window.
 */
import { useRef, useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SuggestionListbox, placeSuggestions, suggestionOptionId } from '../SuggestionListbox'

const VIEW = { width: 1200, height: 800 }

describe('placeSuggestions', () => {
  it('opens below its field, as wide as it, with the room below as its limit', () => {
    expect(placeSuggestions({ left: 100, top: 100, bottom: 130, width: 300 }, 200, VIEW))
      .toEqual({ left: 100, top: 134, width: 300, maxHeight: 800 - 8 - 130 - 4, above: false })
  })

  it('opens above when below has less room than it needs and above has more', () => {
    const at = placeSuggestions({ left: 100, top: 600, bottom: 630, width: 300 }, 320, VIEW)
    expect(at).toMatchObject({ above: true, maxHeight: 600 - 4 - 8, top: 600 - 4 - 320 })
  })

  it('stays below when it fits there, however much room is above', () => {
    expect(placeSuggestions({ left: 100, top: 600, bottom: 630, width: 300 }, 120, VIEW).above).toBe(false)
  })

  it('never runs past the window: a narrow field gets a readable width, pulled in from the right edge', () => {
    const at = placeSuggestions({ left: 1100, top: 100, bottom: 130, width: 90 }, 200, VIEW)
    expect(at.width).toBe(240)
    expect(at.left).toBe(1200 - 8 - 240)
  })
})

const NAMES = (n: number) => Array.from({ length: n }, (_, i) => `prop${String(i + 1).padStart(3, '0')}`)

/** A field that owns its list as the comboboxes do: open while focused, closed on blur. */
function Harness({ names, onPick = () => {} }: { names: string[]; onPick?: (name: string) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  return (
    <>
      <input
        ref={ref}
        role="combobox"
        aria-label="Name"
        aria-expanded={open}
        aria-controls="names"
        aria-activedescendant={open && active >= 0 ? suggestionOptionId('names', active) : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((i) => Math.min(i + 1, names.length - 1))
          if (e.key === 'ArrowUp') setActive((i) => Math.max(i - 1, 0))
        }}
      />
      {open && (
        <SuggestionListbox id="names" label="Names" anchorRef={ref} items={names} getKey={(n) => n}
          renderItem={(n) => <span>{n}</span>} activeIndex={active} onActiveChange={setActive}
          onPick={onPick} rowHeight={36} narrowing={false} />
      )}
    </>
  )
}

afterEach(() => vi.restoreAllMocks())

describe('SuggestionListbox', () => {
  it('offers every match, past the first eight, and says how many there are', async () => {
    const onPick = vi.fn()
    render(<Harness names={NAMES(30)} onPick={onPick} />)
    await userEvent.setup().click(screen.getByRole('combobox', { name: 'Name' }))
    expect(screen.getAllByRole('option')).toHaveLength(30)
    expect(screen.getByText('30 suggestions · type to narrow')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByRole('option', { name: 'prop020' }))
    expect(onPick).toHaveBeenCalledWith('prop020')
  })

  it('keeps the field focused, and the list open, when its scrollbar is pressed', async () => {
    const user = userEvent.setup()
    render(<Harness names={NAMES(30)} />)
    const field = screen.getByRole('combobox', { name: 'Name' })
    await user.click(field)
    const scroller = screen.getByRole('listbox', { name: 'Names' }).parentElement!
    // A press on the scroll area itself — not on a row — is where the scrollbar is.
    await user.pointer({ keys: '[MouseLeft>]', target: scroller })
    await user.pointer({ keys: '[/MouseLeft]', target: scroller })
    expect(field).toHaveFocus()
    expect(screen.getByRole('listbox', { name: 'Names' })).toBeInTheDocument()
  })

  it('reaches the last option by keyboard, keeping it in view', async () => {
    const user = userEvent.setup()
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(288)
    render(<Harness names={NAMES(30)} />)
    const field = screen.getByRole('combobox', { name: 'Name' })
    await user.click(field)
    const scroller = screen.getByRole('listbox', { name: 'Names' }).parentElement!
    for (let i = 0; i < 30; i++) await user.keyboard('{ArrowDown}')
    const last = screen.getByRole('option', { name: 'prop030' })
    expect(field).toHaveAttribute('aria-activedescendant', last.id)
    expect(last).toHaveAttribute('aria-selected', 'true')
    // 30 rows of 36px and the list's padding, less the 288px in view.
    expect(scroller.scrollTop).toBe(30 * 36 + 8 - 288)
    await user.keyboard('{ArrowUp}'.repeat(29))
    expect(scroller.scrollTop).toBe(0)
  })

  it('draws only the rows in view over a hundred, and draws the last when scrolled to it', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(288)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300)
    render(<Harness names={NAMES(312)} />)
    await userEvent.setup().click(screen.getByRole('combobox', { name: 'Name' }))
    const drawn = screen.getAllByRole('option')
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.length).toBeLessThan(40)
    expect(drawn[0]).toHaveAttribute('aria-setsize', '312')
    expect(screen.getByText('312 suggestions · type to narrow')).toBeInTheDocument()
    const scroller = screen.getByRole('listbox', { name: 'Names' }).parentElement!
    scroller.scrollTop = 312 * 36 - 288
    fireEvent.scroll(scroller)
    expect(await screen.findByRole('option', { name: 'prop312' })).toHaveAttribute('aria-posinset', '312')
  })
})
