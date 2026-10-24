/**
 * Code mode stays in step with the query: a change made elsewhere (a
 * canvas question, How it matches, undo) shows in the editor, the user's
 * own apply keeps their spelling, and leaving the editor without typing
 * applies nothing — never an old query over the new one. A query that
 * doesn't parse is never applied; Esc goes back; examples add themselves.
 */
import { EditorView } from '@codemirror/view'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { Predicate } from '@/types/search'

import { CodeMode } from '../dsl/CodeMode'
import type { DslVocabulary } from '../dsl/dslLanguage'
import { stringifyPredicate } from '../predicateDsl'


// jsdom measures no layout; CodeMirror asks Ranges for their boxes.
beforeAll(() => {
    const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) }
    Range.prototype.getClientRects = (() => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] })) as never
    Range.prototype.getBoundingClientRect = (() => rect) as never
})

const DATASETS: Predicate = { kind: 'entityType', op: 'in', values: ['dataset'] }
const FEEDS: Predicate = {
    kind: 'related', axis: 'downstream', maxHops: 3, where: { kind: 'is', refs: [{ urn: 'urn:li:x' }] },
}
const VOCABULARY: DslVocabulary = {
    entityTypes: ['dataset', 'dashboard'], tags: ['PII'], layers: [], propertyKeys: ['owner'], edgeKeys: [],
}

/** The panel around the editor; the button stands for a canvas question
 *  (fireEvent clicks it without moving focus off the editor). */
function Panel({ initial, onCommit }: { initial: Predicate | null; onCommit: (p: Predicate | null) => void }) {
    const [draft, setDraft] = useState(initial)
    return (
        <>
            <button type="button" onClick={() => setDraft(FEEDS)}>Ask from the canvas</button>
            <CodeMode draft={draft} isRunning={false} vocabulary={VOCABULARY}
                      onCommit={(p) => { onCommit(p); setDraft(p) }} />
        </>
    )
}

const content = () => document.querySelector('.cm-content') as HTMLElement
const editor = () => EditorView.findFromDOM(content())!
const text = () => editor().state.doc.toString()
const type = (value: string) => act(() => {
    const view = editor()
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
})
const leave = () => act(() => { fireEvent.blur(content()) })
const press = (key: string, mod = false) => act(() => {
    fireEvent.keyDown(content(), { key, ...(mod ? { ctrlKey: true } : {}) })
})
const askFromTheCanvas = () => fireEvent.click(screen.getByRole('button', { name: 'Ask from the canvas' }))


describe('Code mode', () => {
    it('shows a change made elsewhere after the user applied their own', () => {
        const onCommit = vi.fn()
        render(<Panel initial={null} onCommit={onCommit} />)
        type('type:dataset')
        leave()
        expect(onCommit).toHaveBeenCalledTimes(1)
        askFromTheCanvas()
        expect(text()).toBe(stringifyPredicate(FEEDS))
        // Clicking in and out again changes nothing.
        leave()
        expect(onCommit).toHaveBeenCalledTimes(1)
    })

    it('keeps the user’s spelling when their apply comes back', () => {
        render(<Panel initial={null} onCommit={vi.fn()} />)
        const typed = 'type:dataset    AND    t2'
        type(typed)
        leave()
        expect(text()).toBe(typed)
    })

    it('applies nothing when left untouched, so undo is never overwritten', () => {
        const onCommit = vi.fn()
        render(<Panel initial={DATASETS} onCommit={onCommit} />)
        leave()
        askFromTheCanvas()
        leave()
        expect(onCommit).not.toHaveBeenCalled()
        expect(text()).toBe(stringifyPredicate(FEEDS))
    })

    it('keeps text the user is still typing, and applies it when they leave', () => {
        const onCommit = vi.fn()
        render(<Panel initial={DATASETS} onCommit={onCommit} />)
        type('tag:PII')
        askFromTheCanvas()
        expect(text()).toBe('tag:PII')
        leave()
        expect(onCommit).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'tag', values: ['PII'] }))
    })

    it('never applies a query that does not parse, and says why', () => {
        const onCommit = vi.fn()
        render(<Panel initial={DATASETS} onCommit={onCommit} />)
        type('owner =')
        leave()
        press('Enter', true)
        expect(onCommit).not.toHaveBeenCalled()
        expect(screen.getByRole('status')).toHaveTextContent('Expected a value after owner =')
        expect(screen.getByRole('status')).toHaveTextContent('not applied until it reads')
        expect(text()).toBe('owner =')
    })

    it('applies with ⌘↵ and goes back with Esc', () => {
        const onCommit = vi.fn()
        render(<Panel initial={DATASETS} onCommit={onCommit} />)
        type('tag:PII')
        press('Escape')
        expect(text()).toBe(stringifyPredicate(DATASETS))
        type('tag:PII')
        press('Enter', true)
        expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tag' }))
    })

    it('says what the query reads as while it is typed', () => {
        render(<Panel initial={null} onCommit={vi.fn()} />)
        type('type:dataset orders')
        const status = screen.getByRole('status')
        expect(status).toHaveTextContent('Reads as:')
        expect(status).toHaveTextContent('type is "dataset"')
        expect(status).toHaveTextContent('1 word searched as text in names: orders')
    })

    it('adds an example where the cursor is, inside the quotes of a name', () => {
        render(<Panel initial={null} onCommit={vi.fn()} />)
        fireEvent.click(screen.getByRole('button', { name: /^Add inside @"": / }))
        expect(text()).toBe('inside @""')
        expect(editor().state.selection.main.head).toBe('inside @"'.length)
        fireEvent.click(screen.getByRole('button', { name: /^Add type:dataset: / }))
        expect(text()).toContain('type:dataset')
    })
})
