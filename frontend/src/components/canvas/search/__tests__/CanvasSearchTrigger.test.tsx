/**
 * CanvasSearchTrigger — the floating search button on canvases without a
 * dedicated header (GraphCanvas, HierarchyCanvas). Its keyboard shortcut
 * moved from ⌘K to ⌘⇧F so ⌘K is free for the app-wide palette.
 */
import { render, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

import { CanvasSearchTrigger } from '../CanvasSearchTrigger'

describe('CanvasSearchTrigger', () => {
  it('Cmd/Ctrl+Shift+F toggles search', () => {
    const onToggle = vi.fn()
    render(<CanvasSearchTrigger open={false} onToggle={onToggle} />)

    fireEvent.keyDown(window, { key: 'f', metaKey: true, shiftKey: true })

    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('Cmd/Ctrl+K no longer toggles search', () => {
    const onToggle = vi.fn()
    render(<CanvasSearchTrigger open={false} onToggle={onToggle} />)

    fireEvent.keyDown(window, { key: 'k', metaKey: true })

    expect(onToggle).not.toHaveBeenCalled()
  })
})
