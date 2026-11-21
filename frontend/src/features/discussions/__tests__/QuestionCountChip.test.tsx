/**
 * A card's question chip: the open count, a dot for something unread, said in words for a
 * screen reader — and nothing at all when there is nothing to say. Clicking it (or Enter on it)
 * opens the questions, not the card it sits on.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { QuestionCountChip } from '../QuestionCountChip'

describe('QuestionCountChip', () => {
    it('shows nothing without a count, or with none open and nothing unread', () => {
        const { container, rerender } = render(<QuestionCountChip onOpen={vi.fn()} />)
        expect(container).toBeEmptyDOMElement()
        rerender(<QuestionCountChip count={{ open: 0, answered: 2, total: 3, unread: 0 }} onOpen={vi.fn()} />)
        expect(container).toBeEmptyDOMElement()
    })

    it('shows the open count, and says it with what is unread', () => {
        render(<QuestionCountChip count={{ open: 3, answered: 1, total: 4, unread: 1 }} onOpen={vi.fn()} />)
        const chip = screen.getByRole('button', { name: '3 open questions, 1 unread' })
        expect(chip).toHaveTextContent('3')
        expect(chip.querySelector('.bg-accent-lineage')).not.toBeNull()
    })

    it('says one open question without a dot when it is all read', () => {
        render(<QuestionCountChip count={{ open: 1, answered: 0, total: 1, unread: 0 }} onOpen={vi.fn()} />)
        const chip = screen.getByRole('button', { name: '1 open question' })
        expect(chip.querySelector('.bg-accent-lineage')).toBeNull()
    })

    it('still shows when every question is settled but one is unread', () => {
        render(<QuestionCountChip count={{ open: 0, answered: 1, total: 2, unread: 1 }} onOpen={vi.fn()} />)
        const chip = screen.getByRole('button', { name: '2 questions, all answered or closed, 1 unread' })
        expect(chip).toHaveTextContent('2')
    })

    it('opens the questions and not the card, by click or keyboard', async () => {
        const onOpen = vi.fn()
        const onCard = vi.fn()
        render(
            <div role="button" tabIndex={0} onClick={onCard} onKeyDown={(e) => { if (e.key === 'Enter') onCard() }}>
                <QuestionCountChip count={{ open: 2, answered: 0, total: 2, unread: 0 }} onOpen={onOpen} />
            </div>,
        )
        const chip = screen.getByRole('button', { name: '2 open questions' })
        fireEvent.click(chip)
        expect(onOpen).toHaveBeenCalledTimes(1)
        const user = userEvent.setup()
        await user.tab()
        await user.tab()
        expect(chip).toHaveFocus()
        await user.keyboard('{Enter}')
        expect(onOpen).toHaveBeenCalledTimes(2)
        expect(onCard).not.toHaveBeenCalled()
    })
})
