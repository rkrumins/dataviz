/**
 * The entity a question is about reads as its name after the containers it sits in, with its ID —
 * never its ID alone when it has a name — and hovering it shows the whole of each: the type, the
 * name, the full path and the full ID.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasStore } from '@/store/canvas'
import { usePersonaStore } from '@/store/persona'
import { useSchemaStore } from '@/store/schema'
import { EntityAnchor } from '../EntityAnchor'

const DEEP = { id: 'urn:col', label: 'amount', path: ['Acme', 'Finance', 'Ledgers', 'gl_balances'], type: 'column' }

async function hover() {
    vi.useFakeTimers()
    fireEvent.mouseEnter(screen.getByTestId('entity-anchor').parentElement!)
    await act(async () => { vi.advanceTimersByTime(200) })
    vi.useRealTimers()
    return screen.getByTestId('entity-anchor-details')
}

beforeEach(() => {
    usePersonaStore.setState({ mode: 'business' })
    useSchemaStore.setState({ schema: { containmentEdgeTypes: ['CONTAINS'], views: [], entityTypes: [] } } as never)
    useCanvasStore.setState({ nodes: [], edges: [] } as never)
})

describe('EntityAnchor', () => {
    it('compact: the name after its nearest container, the rest in the hover', async () => {
        render(<EntityAnchor entity={DEEP} />)
        const anchor = screen.getByTestId('entity-anchor')
        expect(within(anchor).getByTestId('entity-anchor-path')).toHaveTextContent('… › gl_balances ›')
        expect(anchor).toHaveTextContent('amount')
        expect(screen.getByText('amount, in Acme › Finance › Ledgers › gl_balances, ID urn:col')).toHaveClass('sr-only')
        const details = await hover()
        expect(details).toHaveTextContent('In Acme › Finance › Ledgers › gl_balances')
        expect(details).toHaveTextContent('ID urn:col')
        expect(details).toHaveTextContent('column')
        expect(details).toHaveTextContent('amount')
    })

    it('full: the path’s start and end, the name, and the ID beneath', () => {
        render(<EntityAnchor entity={DEEP} variant="full" prefix="About" />)
        expect(screen.getByTestId('entity-anchor-path')).toHaveTextContent('Acme › … › Ledgers › gl_balances ›')
        expect(screen.getByTestId('entity-anchor-id')).toHaveTextContent('urn:col')
        expect(screen.getByText(/^About amount, in Acme/)).toHaveClass('sr-only')
    })

    it('full, with copy: the ID can be copied', () => {
        const writeText = vi.fn()
        Object.assign(navigator, { clipboard: { writeText } })
        render(<EntityAnchor entity={DEEP} variant="full" copy />)
        fireEvent.click(screen.getByRole('button', { name: 'Copy ID' }))
        expect(writeText).toHaveBeenCalledWith('urn:col')
    })

    it('a top-level entity has no breadcrumb', () => {
        render(<EntityAnchor entity={{ id: 'urn:db', label: 'Finance', path: [] }} variant="full" />)
        expect(screen.queryByTestId('entity-anchor-path')).toBeNull()
        expect(screen.getByTestId('entity-anchor')).toHaveTextContent('Finance')
    })

    it('a question kept without a name shows its ID once — or the loaded node’s name and path', () => {
        const { unmount } = render(<EntityAnchor entity={{ id: 'urn:col', label: 'urn:col' }} variant="full" />)
        expect(screen.getAllByText('urn:col', { selector: 'code' })).toHaveLength(1)
        expect(screen.queryByTestId('entity-anchor-id')).toBeNull()
        unmount()

        useCanvasStore.setState({
            nodes: [
                { id: 'urn:tbl', position: { x: 0, y: 0 }, data: { label: 'Ledger', urn: 'urn:tbl', type: 'table' } },
                { id: 'urn:col', position: { x: 0, y: 0 }, data: { label: 'Amount', urn: 'urn:col', type: 'column' } },
            ],
            edges: [{ id: 'e', source: 'urn:tbl', target: 'urn:col', data: { edgeType: 'CONTAINS' } }],
        } as never)
        render(<EntityAnchor entity={{ id: 'urn:col', label: null }} />)
        const anchor = screen.getByTestId('entity-anchor')
        expect(anchor).toHaveTextContent('Ledger ›')
        expect(anchor).toHaveTextContent('Amount')
    })
})
