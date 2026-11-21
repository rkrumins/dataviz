/**
 * "What I know": every section the brief has, and none it hasn't; names as the person's mode
 * reads them (type names in Business, ids in Technical); and the heads-up on a generic schema
 * asks, in chat, which property says what kind of thing each one is.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { GENERIC_BRIEF, VIEW_BRIEF } from '@/harness/aiFixtures'
import { usePersonaStore } from '@/store/persona'

import { CONFIRM_TYPE_QUESTION, ContextCard } from '../components/ContextCard'

describe('ContextCard', () => {
    it('shows what it knows about a view, section by section', () => {
        render(<ContextCard variant="block" brief={VIEW_BRIEF} />)
        const card = screen.getByRole('region', { name: 'What I know about Supply chain' })
        expect(within(card).getByText(/Operations › Snowflake prod/)).toBeInTheDocument()
        for (const section of ['Layers', 'Hierarchy', 'Types', 'Connections', 'What’s in it', 'Heads-up']) {
            expect(within(card).getByRole('region', { name: section })).toBeInTheDocument()
        }
        const layers = within(card).getByRole('region', { name: 'Layers' })
        expect(within(layers).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['1Sources', '2Staging', '3Marts', '4Reports'])
        const connections = within(card).getByRole('region', { name: 'Connections' })
        for (const group of ['Hierarchy', 'Lineage', 'Other connections']) expect(within(connections).getByText(group)).toBeInTheDocument()
        expect(within(card).getByText('and 1 more type')).toBeInTheDocument()
        expect(within(card).getByText('1,773')).toBeInTheDocument()
        // Nothing for what the brief doesn't have.
        expect(within(card).queryByRole('region', { name: 'Kinds of thing' })).not.toBeInTheDocument()
    })

    it('reads ids in the Technical view and names in the Business view', () => {
        const { unmount } = render(<ContextCard variant="block" brief={VIEW_BRIEF} />)
        const technical = within(screen.getByRole('region', { name: 'Hierarchy' }))
        expect(technical.getByText('schemaField')).toHaveClass('font-mono')
        expect(screen.getByText('TRANSFORMS')).toBeInTheDocument()
        unmount()

        usePersonaStore.setState({ mode: 'business' })
        render(<ContextCard variant="block" brief={VIEW_BRIEF} />)
        const business = within(screen.getByRole('region', { name: 'Hierarchy' }))
        expect(business.getByText('Column')).not.toHaveClass('font-mono')
        expect(business.queryByText('schemaField')).not.toBeInTheDocument()
        expect(screen.getByText('Transforms')).toBeInTheDocument()
    })

    it('on a generic schema, the heads-up asks which property says what kind of thing each one is', () => {
        const onAsk = vi.fn()
        render(<ContextCard variant="block" brief={GENERIC_BRIEF} onAsk={onAsk} />)
        const kinds = screen.getByRole('region', { name: 'Kinds of thing' })
        expect(within(kinds).getByText('Suggested')).toBeInTheDocument()
        expect(within(kinds).getByText('table')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Tell it which property' }))
        expect(onAsk).toHaveBeenCalledWith(CONFIRM_TYPE_QUESTION)
        expect(CONFIRM_TYPE_QUESTION).toBe('Which property says what kind of thing each one is?')
    })

    it('the summary opens the full card', () => {
        const onOpen = vi.fn()
        render(<ContextCard variant="summary" brief={VIEW_BRIEF} onOpen={onOpen} />)
        expect(screen.getByText('1,773 entities · 9 types · 4 layers')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /What I know/ }))
        expect(onOpen).toHaveBeenCalled()
    })
})
