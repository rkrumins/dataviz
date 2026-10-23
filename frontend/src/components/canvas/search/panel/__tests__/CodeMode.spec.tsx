/**
 * Code mode stays in step with the query: a change made elsewhere (a
 * canvas question, How it matches, undo) shows in the box, the user's own
 * apply keeps their spelling, and leaving the box without typing applies
 * nothing — never an old query over the new one.
 */
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Predicate } from '@/types/search'

import { stringifyPredicate } from '../predicateDsl'
import { CodeMode } from '../QueryCard'


const DATASETS: Predicate = { kind: 'entityType', op: 'in', values: ['dataset'] }
const FEEDS: Predicate = {
    kind: 'related', axis: 'downstream', maxHops: 3, where: { kind: 'is', refs: [{ urn: 'urn:li:x' }] },
}

/** The panel around the box; the button stands for a canvas question
 *  (fireEvent clicks it without moving focus off the box). */
function Panel({ initial, onCommit }: { initial: Predicate | null; onCommit: (p: Predicate | null) => void }) {
    const [draft, setDraft] = useState(initial)
    return (
        <>
            <button type="button" onClick={() => setDraft(FEEDS)}>Ask from the canvas</button>
            <CodeMode draft={draft} isRunning={false} onCommit={(p) => { onCommit(p); setDraft(p) }} />
        </>
    )
}

const box = () => screen.getByRole('textbox') as HTMLTextAreaElement
const askFromTheCanvas = () => fireEvent.click(screen.getByRole('button', { name: 'Ask from the canvas' }))


describe('Code mode', () => {
    it('shows a change made elsewhere after the user applied their own', () => {
        const onCommit = vi.fn()
        render(<Panel initial={null} onCommit={onCommit} />)
        fireEvent.change(box(), { target: { value: 'type:dataset' } })
        fireEvent.blur(box())
        expect(onCommit).toHaveBeenCalledTimes(1)
        askFromTheCanvas()
        expect(box().value).toBe(stringifyPredicate(FEEDS))
        // Clicking in and out again changes nothing.
        fireEvent.focus(box())
        fireEvent.blur(box())
        expect(onCommit).toHaveBeenCalledTimes(1)
    })

    it('keeps the user’s spelling when their apply comes back', () => {
        render(<Panel initial={null} onCommit={vi.fn()} />)
        const typed = 'type:dataset    AND    t2'
        fireEvent.change(box(), { target: { value: typed } })
        fireEvent.blur(box())
        expect(box().value).toBe(typed)
    })

    it('applies nothing when left untouched, so undo is never overwritten', () => {
        const onCommit = vi.fn()
        render(<Panel initial={DATASETS} onCommit={onCommit} />)
        fireEvent.focus(box())
        fireEvent.blur(box())
        askFromTheCanvas()
        fireEvent.focus(box())
        fireEvent.blur(box())
        expect(onCommit).not.toHaveBeenCalled()
        expect(box().value).toBe(stringifyPredicate(FEEDS))
    })

    it('keeps text the user is still typing, and applies it when they leave', () => {
        const onCommit = vi.fn()
        render(<Panel initial={DATASETS} onCommit={onCommit} />)
        fireEvent.change(box(), { target: { value: 'tag:PII' } })
        askFromTheCanvas()
        expect(box().value).toBe('tag:PII')
        fireEvent.blur(box())
        expect(onCommit).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'tag', values: ['PII'] }))
    })
})
