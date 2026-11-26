/**
 * The layer header's name and its actions tray.
 *
 * The name used to share one shrinking row with the count, the sort and every
 * edit button, so in a draft or a narrow column it came down to a few letters,
 * or to nothing. Now the name has the row beside the fold toggle and the icon;
 * the actions wait in a tray that overlays the header's right side on hover and
 * while focus is in it, stays out while something it opened is open, and in a
 * column with too little room shows what fits and leaves the rest to ⋯.
 *
 * jsdom has no layout and no :hover, so the reveal is pinned by its classes and
 * the room by a ResizeObserver that reports a width; the Context View harness
 * is where it is seen.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ViewRowSearchContext,
  ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import { usePersonaStore } from '@/store/persona'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import type { ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'

const NAME = 'Curated reporting marts for finance and the executive team'
const layer: ViewLayerConfig = { id: 'L1', name: NAME, entityTypes: [], order: 0, color: '#4488ff' }

function renderHeader(extra: Partial<React.ComponentProps<typeof LayerColumn>> = {}) {
  const session = stubSession()
  const actions = {
    onHeaderContextMenu: vi.fn(),
    onAddToLayer: vi.fn(),
    onCreateGroup: vi.fn(),
    onBuildToLayer: vi.fn(),
    onRenameLayer: vi.fn(),
    onDeleteLayer: vi.fn(),
    onSetSortMode: vi.fn(),
  }
  const column = (more: Partial<React.ComponentProps<typeof LayerColumn>>) => (
    <ViewSearchSessionContext.Provider value={session}>
      <ViewRowSearchContext.Provider value={session.rowSearch}>
        <LayerColumn
          layer={layer} schema={null} nodes={[]} selectedNodeId={null}
          expandedNodes={new Set<string>()} searchResults={new Set<string>()}
          onSelect={vi.fn()} onSelectRange={vi.fn()} onToggle={vi.fn()} onContextMenu={vi.fn()}
          onDoubleClick={vi.fn()} traceFocusId={null} traceNodes={new Set<string>()}
          traceContextSet={new Set<string>()} overscan={200}
          {...actions}
          {...extra}
          {...more}
        />
      </ViewRowSearchContext.Provider>
    </ViewSearchSessionContext.Provider>
  )
  const { rerender } = render(column({}))
  return { actions, rerender: (more: Partial<React.ComponentProps<typeof LayerColumn>>) => rerender(column(more)) }
}

/** Every observed box reports this width — the title's box among them. */
function observeWidth(width: number) {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element) {
      const size = { inlineSize: width, blockSize: 40 }
      this.cb([{
        target, contentRect: { width, height: 40 } as DOMRectReadOnly,
        borderBoxSize: [size], contentBoxSize: [size], devicePixelContentBoxSize: [size],
      }], this as unknown as ResizeObserver)
    }
    unobserve() {}
    disconnect() {}
  })
}

const tray = () => screen.getByRole('group', { name: `${NAME}: actions` })
const has = (name: string) => !!screen.queryByRole('button', { name })

beforeEach(() => {
  installJsdomLayout()
  usePersonaStore.setState({ mode: 'technical' })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('LayerColumn header — the name', () => {
  it('is the header’s name, in full, and shares its row with no action', () => {
    renderHeader()
    // The header is named for its layer, whatever the clamp shows.
    expect(screen.getByRole('group', { name: NAME })).toBeInTheDocument()
    const name = screen.getByRole('heading', { name: NAME })
    // The tray overlays the row rather than taking width in it…
    expect(tray().className).toMatch(/(^|\s)absolute(\s|$)/)
    expect(tray().contains(name)).toBe(false)
    // …and nothing else in the row is an action: the fold toggle, the icon and the title.
    const row = tray().parentElement!
    const flowing = [...row.children].filter((child) => child !== tray())
    expect(flowing.some((child) => child.contains(name))).toBe(true)
    for (const child of flowing) {
      for (const button of child.querySelectorAll('button')) {
        expect(button.getAttribute('title')).toBe('Fold this layer')
      }
    }
  })

  it('keeps its count out of the tray, on show at rest', () => {
    renderHeader()
    const count = screen.getByTitle(/entities in the tree/)
    expect(tray().contains(count)).toBe(false)
  })

  it('gives an inline rename the whole row: no tray while it is open', () => {
    renderHeader()
    fireEvent.click(screen.getByRole('button', { name: `Rename ${NAME}` }))
    expect(screen.getByRole('textbox', { name: `Rename ${NAME}` })).toHaveFocus()
    expect(screen.queryByRole('group', { name: `${NAME}: actions` })).toBeNull()
  })
})

describe('LayerColumn header — the actions tray', () => {
  it('is hidden at rest and rises on the header’s hover and on focus inside it', () => {
    renderHeader()
    const header = screen.getByRole('group', { name: NAME })
    expect(header.className).toContain('group/header')
    const classes = tray().className.split(/\s+/)
    expect(classes).toEqual(expect.arrayContaining([
      'opacity-0', 'pointer-events-none',
      'group-hover/header:opacity-100', 'group-hover/header:pointer-events-auto',
      'focus-within:opacity-100', 'focus-within:pointer-events-auto',
      // A device with no hover keeps it on show.
      '[@media(hover:none)]:opacity-100',
    ]))
    expect(tray()).not.toHaveAttribute('data-pinned')
  })

  it('its trash asks the canvas to delete the layer — whose dialog is the confirm, saying what happens', () => {
    const { actions } = renderHeader()
    fireEvent.click(screen.getByRole('button', { name: `Delete ${NAME}` }))
    expect(actions.onDeleteLayer).toHaveBeenCalledWith('L1')
    expect(has(`Yes, delete ${NAME}`)).toBe(false)
  })

  it('stays out while the sort menu is open', async () => {
    const user = userEvent.setup()
    renderHeader()
    await user.click(screen.getByRole('button', { name: /^Sort / }))
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    expect(tray()).toHaveAttribute('data-pinned', 'true')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(tray()).not.toHaveAttribute('data-pinned')
  })

  it('stays out while the layer’s menu is open, and says the ⋯ is expanded', () => {
    const { rerender } = renderHeader()
    const more = screen.getByRole('button', { name: `${NAME}: layer actions` })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    rerender({ layerMenuOpen: true })
    expect(tray()).toHaveAttribute('data-pinned', 'true')
    expect(more).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('LayerColumn header — room for the tray', () => {
  const optional = [
    `Add entity to ${NAME}`, `New group in ${NAME}`, `Build a lot at once in ${NAME}`,
    `Rename ${NAME}`, `Delete ${NAME}`,
  ]

  it('in a wide column shows every action', () => {
    observeWidth(400)
    renderHeader()
    for (const name of optional) expect(has(name)).toBe(true)
  })

  it('in a narrow column folds to the sort and ⋯, which opens the layer’s menu', () => {
    observeWidth(200)
    const { actions } = renderHeader()
    for (const name of optional) expect(has(name)).toBe(false)
    expect(has(`${NAME}: layer actions`)).toBe(true)
    expect(screen.getByRole('button', { name: /^Sort / })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: `${NAME}: layer actions` }))
    expect(actions.onHeaderContextMenu).toHaveBeenCalledWith(expect.anything(), 'L1')
  })

  it('in between, shows the most wanted that fit and leaves the rest to ⋯', () => {
    // (260 − 96 peek − 24 fade) / 28 = 5 slots: the sort, ⋯ and three more.
    observeWidth(260)
    renderHeader()
    expect(optional.map(has)).toEqual([true, true, true, false, false])
  })

  it('with no menu to hold them, shows them all however narrow', () => {
    observeWidth(200)
    renderHeader({ onHeaderContextMenu: undefined })
    for (const name of optional) expect(has(name)).toBe(true)
  })

  it('in the Business view, keeps to the sort, the rename and ⋯', () => {
    usePersonaStore.setState({ mode: 'business' })
    observeWidth(400)
    renderHeader()
    expect(optional.map(has)).toEqual([false, false, false, true, false])
    expect(has(`${NAME}: layer actions`)).toBe(true)
  })
})
