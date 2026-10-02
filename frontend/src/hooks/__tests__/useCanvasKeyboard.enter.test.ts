/**
 * Enter belongs to the focused control first, and to the canvas second.
 *
 * The hook listens on `document` and used to `preventDefault()` Enter
 * unconditionally — before the optional-chained `onEdit`, so it fired even
 * when no handler existed. Its typing-guard exempts only INPUT / TEXTAREA /
 * contentEditable, so a focused <button> or <a href> went straight through:
 * with any canvas mounted (all three mount it with `enabled: true`, inside
 * AppLayout), Enter did nothing on every button and link in the app. Space
 * still worked on a <button> — activation fires on keyup — which is why it
 * read as half-broken rather than dead; <a href> has no such fallback.
 *
 * These pin the two halves of the rule: never cancel Enter for something
 * Enter already activates, and never cancel it when this hook has nothing
 * to do with it.
 */
import { renderHook, fireEvent } from '@testing-library/react'
import { afterEach, describe, it, expect, vi } from 'vitest'

import { useCanvasKeyboard } from '../useCanvasKeyboard'

const mounted: HTMLElement[] = []

function focusable(html: string): HTMLElement {
    const host = document.createElement('div')
    host.innerHTML = html
    const el = host.firstElementChild as HTMLElement
    document.body.appendChild(el)
    mounted.push(el)
    return el
}

function mount(handlers: Parameters<typeof useCanvasKeyboard>[0]['handlers']) {
    renderHook(() => useCanvasKeyboard({ enabled: true, handlers }))
}

afterEach(() => {
    while (mounted.length) mounted.pop()!.remove()
})

describe('useCanvasKeyboard — Enter must not be stolen from focused controls', () => {
    it.each([
        ['a button', '<button>Save</button>'],
        ['a link', '<a href="/workspaces">Workspaces</a>'],
        ['role=button', '<div role="button" tabindex="0">Save</div>'],
        ['role=link', '<div role="link" tabindex="0">Go</div>'],
        ['role=menuitem', '<div role="menuitem" tabindex="0">Delete</div>'],
        ['role=option', '<div role="option" tabindex="0">Sales</div>'],
        ['role=tab', '<div role="tab" tabindex="0">Members</div>'],
        ['role=checkbox', '<div role="checkbox" tabindex="0">Include drafts</div>'],
    ])('leaves Enter alone on %s', (_label, html) => {
        const onEdit = vi.fn()
        mount({ onEdit })
        const el = focusable(html)

        const notCancelled = fireEvent.keyDown(el, { key: 'Enter', bubbles: true })

        expect(notCancelled).toBe(true)
        expect(onEdit).not.toHaveBeenCalled()
    })

    it('does not cancel Enter when no onEdit handler is wired', () => {
        mount({})

        const notCancelled = fireEvent.keyDown(document.body, { key: 'Enter' })

        expect(notCancelled).toBe(true)
    })

    it('still edits the selection on Enter from the canvas itself', () => {
        const onEdit = vi.fn()
        mount({ onEdit })

        const notCancelled = fireEvent.keyDown(document.body, { key: 'Enter' })

        expect(onEdit).toHaveBeenCalledTimes(1)
        expect(notCancelled).toBe(false)
    })

    it('leaves Cmd/Ctrl+Enter alone, as before', () => {
        const onEdit = vi.fn()
        mount({ onEdit })

        fireEvent.keyDown(document.body, { key: 'Enter', metaKey: true })

        expect(onEdit).not.toHaveBeenCalled()
    })
})
