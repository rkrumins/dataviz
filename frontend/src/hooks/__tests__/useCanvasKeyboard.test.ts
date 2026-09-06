/**
 * useCanvasKeyboard — shortcut reallocation (B9 / C8).
 *
 * `/` focuses the view search box, ⌘⇧F toggles the results panel, and the
 * canvas action palette moves off ⌘K (now app-wide only, see
 * layout/CommandPalette.tsx) onto ⌘⇧P. Plain `f` still opens the Lineage
 * Lens — the new ⌘⇧F binding must not shadow it.
 */
import { renderHook } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

import { useCanvasKeyboard } from '../useCanvasKeyboard'

function setup(overrides: Partial<Parameters<typeof useCanvasKeyboard>[0]['handlers']> = {}) {
  const handlers = {
    onFocusSearch: vi.fn(),
    onToggleSearchPanel: vi.fn(),
    onFocusLens: vi.fn(),
    onCommandPalette: vi.fn(),
    ...overrides,
  }
  renderHook(() => useCanvasKeyboard({ enabled: true, handlers }))
  return handlers
}

describe('useCanvasKeyboard — search shortcuts', () => {
  it('/ focuses the view search box', () => {
    const handlers = setup()

    fireEvent.keyDown(document.body, { key: '/' })

    expect(handlers.onFocusSearch).toHaveBeenCalledTimes(1)
  })

  it('/ typed into an input does not fire onFocusSearch', () => {
    const handlers = setup()
    const input = document.createElement('input')
    document.body.appendChild(input)

    fireEvent.keyDown(input, { key: '/' })

    expect(handlers.onFocusSearch).not.toHaveBeenCalled()
    document.body.removeChild(input)
  })

  it('Cmd/Ctrl+Shift+F toggles the search results panel', () => {
    const handlers = setup()

    fireEvent.keyDown(document.body, { key: 'f', metaKey: true, shiftKey: true })

    expect(handlers.onToggleSearchPanel).toHaveBeenCalledTimes(1)
  })

  it('plain f still opens the Lineage Lens', () => {
    const handlers = setup()

    fireEvent.keyDown(document.body, { key: 'f' })

    expect(handlers.onFocusLens).toHaveBeenCalledTimes(1)
    expect(handlers.onToggleSearchPanel).not.toHaveBeenCalled()
  })
})

describe('useCanvasKeyboard — command palette reallocation (C8)', () => {
  it('Cmd/Ctrl+K no longer opens the canvas action palette', () => {
    const handlers = setup()

    fireEvent.keyDown(document.body, { key: 'k', metaKey: true })

    expect(handlers.onCommandPalette).not.toHaveBeenCalled()
  })

  it('Cmd/Ctrl+Shift+P opens the canvas action palette', () => {
    const handlers = setup()

    fireEvent.keyDown(document.body, { key: 'p', metaKey: true, shiftKey: true })

    expect(handlers.onCommandPalette).toHaveBeenCalledTimes(1)
  })
})
