/**
 * A finished simple condition folds to one line of words, each part a
 * token that opens the condition's editor; a chevron opens the full card.
 * A new or unfinished row opens as its card, and folds once finished when
 * the person moves on.
 */
import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSchemaStore } from '@/store/schema'
import type { Predicate } from '@/types/search'

import { ConditionRow } from '../ConditionRow'


const before = useSchemaStore.getState().schema

function Row({ initial, autoFocus, onChange = vi.fn() }: {
    initial: Predicate
    autoFocus?: boolean
    onChange?: (p: Predicate) => void
}) {
    const [value, setValue] = useState<Predicate>(initial)
    return (
        <>
            <ConditionRow
                value={value}
                discovery={{
                    allKeys: ['rowCount', 'owner'], keysByEntityType: {}, tagValues: ['Certified', 'PII'],
                    getValueSamples: () => [],
                }}
                knownEntityTypes={['dataset', 'dashboard']}
                activeEntityTypes={[]}
                discoveredLayers={[{ value: 'mart', label: 'Reporting layer' }]}
                isRunning={false}
                autoFocus={autoFocus}
                onChange={(p) => { setValue(p); onChange(p) }}
                onRemove={vi.fn()}
            />
            <button type="button">Elsewhere</button>
        </>
    )
}

/** The words the folded row says, its tokens included. */
const line = () => document.querySelector('[aria-haspopup="dialog"]')!.parentElement!.textContent!
    .replace(/\s+/g, ' ').trim()


describe('a finished condition reads as one line', () => {
    beforeEach(() => {
        useSchemaStore.setState({ schema: {
            ...(before ?? {}),
            entityTypes: [{ id: 'dataset', name: 'Dataset' }, { id: 'dashboard', name: 'Dashboard' }],
        } as unknown as typeof before })
    })
    afterEach(() => useSchemaStore.setState({ schema: before }))

    it.each<[string, Predicate, string]>([
        ['types, by name', { kind: 'entityType', values: ['dataset', 'dashboard'] }, 'Type is one of Dataset, Dashboard'],
        ['types left out', { kind: 'entityType', values: ['dataset'], op: 'notIn' }, 'Type is not Dataset'],
        ['tags', { kind: 'tag', values: ['Certified', 'PII'] }, 'Is tagged #Certified, #PII'],
        ['text', { kind: 'text', value: 'orders', target: 'name', match: 'prefix' }, 'Name starts with “orders”'],
        ['a property value', { kind: 'property', key: 'rowCount', op: 'gt', value: 100000, valueType: 'number' },
            '“rowCount” is greater than 100000'],
        ['another property', { kind: 'property', key: 'freshnessHours', op: 'gt', valueKey: 'slaHours' },
            '“freshnessHours” is greater than its “slaHours”'],
        ['a property set', { kind: 'hasProperty', key: 'owner' }, 'Has a “owner” property'],
        ['a layer, by name', { kind: 'layer', layerAssignment: 'mart' }, 'In layer Reporting layer'],
        ['a graph shape, by its name', { kind: 'isLeaf' }, 'No downstream lineage'],
        ['a graph shape through links', { kind: 'isRoot', edgeClass: 'links' }, 'Nothing links into it'],
        ['a named entity', { kind: 'is', refs: [{ path: ['Finance', 'orders'] }] }, 'Is “Finance / orders”'],
    ])('%s', (_name, value, words) => {
        render(<Row initial={value} />)
        expect(line()).toBe(words)
        expect(line()).not.toMatch(/Restrict to|Match nodes/)
        expect(screen.getByRole('button', { name: 'Show all options' })).toHaveAttribute('aria-expanded', 'false')
    })

    it('names each part for a screen reader, with what it is', () => {
        render(<Row initial={{ kind: 'tag', values: ['Certified'] }} />)
        expect(screen.getByRole('button', { name: 'Tag: #Certified' })).toHaveAttribute('aria-haspopup', 'dialog')
    })
})


describe('a token opens the condition’s editor', () => {
    it('edits the condition there, and the line says the change', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()
        render(<Row initial={{ kind: 'text', value: 'orders', target: 'name', match: 'substring' }} onChange={onChange} />)
        await user.click(screen.getByRole('button', { name: /: “orders”$/ }))
        const editor = await screen.findByRole('dialog', { name: 'Text in name or description' })
        const input = within(editor).getByDisplayValue('orders')
        expect(input).toHaveFocus()
        await user.type(input, '_v2')
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ value: 'orders_v2' }))
        await user.keyboard('{Escape}')
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(line()).toBe('Name contains “orders_v2”')
        expect(screen.getByRole('button', { name: /: “orders_v2”$/ })).toHaveFocus()
    })
})


describe('the chevron opens the full card', () => {
    it('opens and folds it again', async () => {
        const user = userEvent.setup()
        render(<Row initial={{ kind: 'tag', values: ['Certified'] }} />)
        await user.click(screen.getByRole('button', { name: 'Show all options' }))
        const fold = screen.getByRole('button', { name: 'Fold to one line' })
        expect(fold).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText('Match nodes by their assigned tags.')).toBeInTheDocument()
        // Opened by hand, it stays open when the person moves on.
        await user.click(screen.getByRole('button', { name: 'Elsewhere' }))
        expect(screen.getByRole('button', { name: 'Fold to one line' })).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Fold to one line' }))
        expect(line()).toBe('Is tagged #Certified')
    })

    it('is not offered where the options are the point: relationships, paths and edge counts', () => {
        render(<Row initial={{ kind: 'related', axis: 'downstream', quantifier: 'any' }} />)
        render(<Row initial={{ kind: 'degree', direction: 'out', op: 'gte', value: 2 }} />)
        expect(screen.queryByRole('button', { name: 'Show all options' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Fold to one line' })).toBeNull()
    })
})


describe('a new or unfinished row opens as its card', () => {
    it('opens a new row, and folds it once finished when the person moves on', async () => {
        const user = userEvent.setup()
        render(<Row initial={{ kind: 'text', value: '', target: 'name', match: 'substring' }} autoFocus />)
        const input = screen.getByPlaceholderText('type to search…')
        expect(input).toHaveFocus()
        // Unfinished, it stays open.
        await user.click(screen.getByRole('button', { name: 'Elsewhere' }))
        expect(screen.getByPlaceholderText('type to search…')).toBeInTheDocument()
        await user.type(screen.getByPlaceholderText('type to search…'), 'orders')
        // A click inside it is not moving on.
        await user.click(screen.getByText('Text in name or description'))
        expect(screen.getByPlaceholderText('type to search…')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Elsewhere' }))
        expect(screen.queryByPlaceholderText('type to search…')).toBeNull()
        expect(line()).toBe('Name contains “orders”')
    })

    it('folds when focus leaves it, too', async () => {
        const user = userEvent.setup()
        render(<Row initial={{ kind: 'text', value: '', target: 'name', match: 'substring' }} autoFocus />)
        await user.keyboard('orders')
        await user.tab()
        expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus()
        expect(screen.queryByPlaceholderText('type to search…')).toBeNull()
    })

    it('does not fold on a pick in a menu of its own', async () => {
        render(<Row initial={{ kind: 'tag', values: ['Certified'] }} autoFocus />)
        const menu = document.createElement('div')
        menu.setAttribute('data-floating-layer', '')
        document.body.appendChild(menu)
        fireEvent.pointerDown(menu)
        fireEvent.click(menu)
        expect(screen.getByRole('button', { name: 'Fold to one line' })).toBeInTheDocument()
        menu.remove()
    })

    it('folds once a press away has clicked, not as it starts', () => {
        // Folding mid-press would move what's below under the pointer: the
        // click "Add filter" began under a row just finished would miss.
        render(<Row initial={{ kind: 'tag', values: ['Certified'] }} autoFocus />)
        const elsewhere = screen.getByRole('button', { name: 'Elsewhere' })
        fireEvent.pointerDown(elsewhere)
        fireEvent.focusIn(elsewhere)
        expect(screen.getByRole('button', { name: 'Fold to one line' })).toBeInTheDocument()
        fireEvent.pointerUp(elsewhere)
        fireEvent.click(elsewhere)
        expect(line()).toBe('Is tagged #Certified')
    })

    it('opens a saved row that is unfinished', () => {
        render(<Row initial={{ kind: 'tag', values: [] }} />)
        expect(screen.getByRole('button', { name: 'Fold to one line' })).toBeInTheDocument()
    })
})
