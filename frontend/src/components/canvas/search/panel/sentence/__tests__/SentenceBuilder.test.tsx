/**
 * The Sentence builder edits the same draft as the Form cards, through the
 * same two writes: a value changed seeds the draft (no undo step), a change
 * of shape commits it. The words joining the clauses are themselves the
 * all/any choice, the map opens the sentence's tokens, and what no
 * builder edits hands over to Code.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Predicate } from '@/types/search'

import { SentenceBuilder } from '../SentenceBuilder'


const type = (...values: string[]): Predicate => ({ kind: 'entityType', op: 'in', values })
const tag = (...values: string[]): Predicate => ({ kind: 'tag', op: 'hasAny', values })
const all = (...children: Predicate[]): Predicate => ({ kind: 'group', op: 'and', children })
const any = (...children: Predicate[]): Predicate => ({ kind: 'group', op: 'or', children })

const discovery = { allKeys: [], keysByEntityType: {}, tagValues: ['PII', 'GDPR'], getValueSamples: () => [] }

function setup(initial: Predicate | null) {
    const onSeed = vi.fn()
    const onCommit = vi.fn()
    const onEditInCode = vi.fn()
    function Harness() {
        const [draft, setDraft] = useState(initial)
        return (
            <SentenceBuilder viewId="view-a" predicate={draft} discovery={discovery}
                             knownEntityTypes={['dataset', 'chart']} presentEntityTypes={['dataset', 'chart']}
                             discoveredLayers={[]} onEditInCode={onEditInCode}
                             onSeed={(next) => { onSeed(next); setDraft(next) }}
                             onCommit={(next) => { onCommit(next); setDraft(next) }} />
        )
    }
    render(<Harness />)
    return { onSeed, onCommit, onEditInCode }
}


describe('SentenceBuilder', () => {
    beforeEach(() => localStorage.clear())

    it('reads the query as a sentence of tokens', () => {
        setup(all(type('dataset'), tag('PII')))
        const sentence = screen.getByRole('list', { name: 'The query, as a sentence' })
        expect(within(sentence).getByText('Find')).toBeInTheDocument()
        expect(within(sentence).getByRole('button', { name: 'What the query finds: dataset' })).toBeInTheDocument()
        expect(within(sentence).getByRole('button', { name: 'Which tags: #PII' })).toBeInTheDocument()
        // No relationship, no route: nothing to draw.
        expect(screen.queryByRole('figure', { name: "The query's shape" })).not.toBeInTheDocument()
    })

    it('changes a value without an undo step', async () => {
        const { onSeed, onCommit } = setup(all(type('dataset'), tag('PII')))
        fireEvent.click(screen.getByRole('button', { name: 'What the query finds: dataset' }))
        await userEvent.click(await screen.findByRole('option', { name: /chart/ }))
        expect(onSeed).toHaveBeenLastCalledWith(all(type('dataset', 'chart'), tag('PII')))
        expect(onCommit).not.toHaveBeenCalled()
    })

    it('joins the clauses by any when its "and" is changed to "or"', async () => {
        const { onCommit } = setup(all(type('dataset'), tag('PII'), { kind: 'isLeaf' }))
        fireEvent.click(screen.getByRole('button', { name: 'How the conditions combine: and' }))
        await userEvent.click(screen.getByRole('option', { name: /Any of them/ }))
        expect(onCommit).toHaveBeenLastCalledWith(all(type('dataset'), any(tag('PII'), { kind: 'isLeaf' })))
        // Still listed as the subject's clauses — now joined by "or".
        expect(screen.getByRole('button', { name: 'How the conditions combine: or' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'How the conditions combine: or' }))
        await userEvent.click(screen.getByRole('option', { name: /All of them/ }))
        expect(onCommit).toHaveBeenLastCalledWith(all(type('dataset'), tag('PII'), { kind: 'isLeaf' }))
    })

    it('puts a new subject before clauses joined by any, keeping them so', async () => {
        const { onCommit } = setup(any(tag('PII'), tag('GDPR')))
        fireEvent.click(screen.getByRole('button', { name: 'What the query finds: anything' }))
        await userEvent.click(await screen.findByRole('option', { name: /dataset/ }))
        expect(onCommit).toHaveBeenLastCalledWith(all(type('dataset'), any(tag('PII'), tag('GDPR'))))
    })

    it('removes a clause from its line\'s menu, as a change of shape', async () => {
        const { onCommit } = setup(all(type('dataset'), tag('PII'), { kind: 'isLeaf' }))
        const user = userEvent.setup()
        await user.click(screen.getAllByRole('button', { name: 'Line actions' })[0])
        await user.click(await screen.findByRole('menuitem', { name: 'Remove' }))
        expect(onCommit).toHaveBeenLastCalledWith(all(type('dataset'), { kind: 'isLeaf' }))
    })

    it('draws the shape of a relationship, and its nodes open the sentence\'s tokens', async () => {
        setup(all(type('dataset'), { kind: 'related', axis: 'downstream', maxHops: 3, where: type('chart') }))
        expect(screen.getByRole('figure', { name: "The query's shape" })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /^Change which relatives: chart/ }))
        expect(await screen.findByRole('dialog', { name: 'Which types' })).toBeInTheDocument()
    })

    it('hands a condition no builder edits over to Code', async () => {
        const { onEditInCode } = setup({ kind: 'degree', direction: 'out', op: 'gt', value: 3 } as Predicate)
        fireEvent.click(screen.getAllByRole('button', { name: /out edges gt 3/ })[0])
        await userEvent.click(await screen.findByRole('button', { name: 'Edit in Code' }))
        expect(onEditInCode).toHaveBeenCalled()
    })
})
